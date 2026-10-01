import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { EventProducer } from "../config/event-credentials.js";
import { type CloudEvent, parseCloudEvent } from "./cloudevent.js";
import type { EventPipeline } from "./pipeline.js";
import {
  EventIntakeError,
  type EventRecord,
  type EventStore,
  eventStatus,
} from "./store.js";

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function receipt(record: EventRecord): unknown {
  return {
    receipt_id: record.receiptId,
    status: eventStatus(record),
    accepted_at: record.acceptedAt,
    recipients: record.recipients.map((r) => ({
      profile_id: r.profileId,
      ...(r.triggerId ? { trigger_id: r.triggerId } : {}),
    })),
  };
}
async function body(request: IncomingMessage, max: number): Promise<unknown> {
  const length = request.headers["content-length"];
  if (length && Number(length) > max)
    throw new EventIntakeError(413, "Event body too large");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        request.resume();
        reject(new EventIntakeError(413, "Event body too large"));
      } else chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAborted = (): void => {
      cleanup();
      reject(new EventIntakeError(400, "Incomplete event body"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new EventIntakeError(400, "Event body must be valid UTF-8 JSON");
  }
}

export async function startEventServer(options: {
  listen: string;
  port: number;
  maxBodyBytes: number;
  producers: EventProducer[];
  pipeline: EventPipeline;
  store: EventStore;
  onFatal(error: Error): void;
}): Promise<{ port: number; close(): Promise<void> }> {
  const credentials = options.producers.map((producer) => ({
    producer,
    hash: createHash("sha256").update(producer.token).digest(),
  }));
  let failed = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (failed) throw new EventIntakeError(503, "Event intake unavailable");
      const authorization = request.headers.authorization;
      const candidate = createHash("sha256")
        .update(
          authorization?.startsWith("Bearer ") ? authorization.slice(7) : "",
        )
        .digest();
      const producer = credentials.find(({ hash }) =>
        timingSafeEqual(candidate, hash),
      )?.producer;
      if (!producer)
        throw new EventIntakeError(401, "Invalid event credentials");
      const path = request.url;
      if (request.method === "GET" && path?.startsWith("/v1/events/")) {
        const record = await options.store.get(
          path.slice("/v1/events/".length),
        );
        if (
          !record ||
          record.producerId !== producer.id ||
          !producer.sources.includes(record.event.source)
        )
          throw new EventIntakeError(404, "Unknown event receipt");
        reply(response, 200, receipt(record));
        return;
      }
      if (path !== "/v1/events")
        throw new EventIntakeError(404, "Unknown event endpoint");
      if (request.method !== "POST")
        throw new EventIntakeError(405, "Use POST to submit an event");
      if (
        request.headers["content-encoding"] &&
        request.headers["content-encoding"] !== "identity"
      )
        throw new EventIntakeError(415, "Compressed events are not supported");
      if (
        request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
        "application/cloudevents+json"
      )
        throw new EventIntakeError(
          415,
          "Use application/cloudevents+json structured mode",
        );
      const value = await body(request, options.maxBodyBytes);
      let event: CloudEvent;
      try {
        event = parseCloudEvent(value);
      } catch {
        throw new EventIntakeError(400, "Invalid or unsupported CloudEvent");
      }
      const result = await options.pipeline.accept(event, producer);
      response.setHeader("location", `/v1/events/${result.record.receiptId}`);
      reply(response, result.created ? 202 : 200, {
        ...(receipt(result.record) as object),
        duplicate: !result.created,
      });
    })().catch((error: unknown) => {
      if (error instanceof EventIntakeError) {
        if (error.status === 503) response.setHeader("retry-after", "5");
        if (error.status === 401)
          response.setHeader("www-authenticate", "Bearer");
        reply(response, error.status, { error: error.message });
      } else {
        failed = true;
        reply(response, 500, { error: "Event intake failed" });
        options.onFatal(
          new Error("Event HTTP intake failed", { cause: error }),
        );
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.listen, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", options.onFatal);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Event server has no TCP address");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
