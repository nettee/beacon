import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultChannelsPath,
  loadChannelRegistry,
} from "../config/channels.js";
import { loadProfile } from "../config/profile.js";
import {
  type AgentSystemPromptTrigger,
  buildAgentSystemPrompt,
} from "../runtime/system-prompt.js";
import {
  buildCostStats,
  parseCostModelFilter,
  parseCostPeriod,
} from "./cost-stats.js";
import { exportSessionHtml } from "./export.js";
import {
  listModelAllocations,
  ModelAllocationError,
  putModelAllocation,
} from "./model-allocation.js";
import {
  getProfileDetailView,
  isProfileId,
  listProfileViews,
} from "./profiles.js";
import {
  findRunSummary,
  listRunSummaries,
  type RunSummary,
  runIdPattern,
  toRunListItem,
} from "./records.js";
import { sendStaticFile } from "./static.js";

const JSON_BODY_MAX_BYTES = 64 * 1024;

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const lengthHeader = request.headers["content-length"];
  if (lengthHeader && Number(lengthHeader) > maxBytes) {
    throw new ModelAllocationError(413, "Request body too large");
  }
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
      if (size > maxBytes) {
        cleanup();
        request.resume();
        reject(new ModelAllocationError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAborted = (): void => {
      cleanup();
      reject(new ModelAllocationError(400, "Incomplete request body"));
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
  if (bytes.length === 0) {
    throw new ModelAllocationError(400, "Request body required");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ModelAllocationError(400, "Body must be valid UTF-8 JSON");
  }
}

export type DashboardOptions = {
  listen: string;
  port: number;
  profilesDirectory: string;
  sessionDirectory: string;
  piExecutable: string;
  exportTimeoutMs?: number | undefined;
  uiDirectory?: string | undefined;
};

export type DashboardServer = {
  port: number;
  close(): Promise<void>;
};

type CacheEntry = {
  key: string;
  html: string;
};

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  send(response, status, "text/plain; charset=utf-8", `${body}\n`);
}

export function defaultUiDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "ui");
}

function triggerFromRunSummary(summary: RunSummary): AgentSystemPromptTrigger {
  if (summary.kind === "schedule") {
    return {
      kind: "schedule",
      ...(summary.scheduleId ? { scheduleId: summary.scheduleId } : {}),
      notify: summary.hasNotifyTarget,
    };
  }
  if (summary.kind === "event") {
    return { kind: "event", notify: summary.hasNotifyTarget };
  }
  if (summary.kind === "feishu_message") {
    return { kind: "feishu_message", notify: false };
  }
  if (summary.kind === "on_failure") {
    return { kind: "on_failure", notify: summary.hasNotifyTarget };
  }
  return { kind: "manual", notify: summary.hasNotifyTarget };
}

async function beaconOwnedSystemPrompt(
  summary: RunSummary,
  profilesDirectory: string,
): Promise<string | undefined> {
  if (summary.systemPrompt) return summary.systemPrompt;
  try {
    const channelsPath = defaultChannelsPath(dirname(profilesDirectory));
    const channels = await loadChannelRegistry(channelsPath);
    return buildAgentSystemPrompt(
      await loadProfile(summary.profileId, profilesDirectory, {
        channels,
        channelsPath,
      }),
      triggerFromRunSummary(summary),
    );
  } catch {
    // Old runs without a stored prompt: reconstruction needs a readable Profile.
    return undefined;
  }
}

export async function startDashboard(
  options: DashboardOptions,
): Promise<DashboardServer> {
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<string>>();
  const uiDirectory = options.uiDirectory ?? defaultUiDirectory();

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://beacon.local");

    if (method === "PUT" && url.pathname.startsWith("/api/")) {
      const allocationMatch =
        /^\/api\/profiles\/([^/]+)\/model-allocation$/.exec(url.pathname);
      if (allocationMatch) {
        const profileId = decodeURIComponent(allocationMatch[1] ?? "");
        try {
          const body = await readJsonBody(request, JSON_BODY_MAX_BYTES);
          const result = await putModelAllocation(
            options.profilesDirectory,
            profileId,
            body,
          );
          send(
            response,
            200,
            "application/json; charset=utf-8",
            `${JSON.stringify(result)}\n`,
          );
        } catch (error) {
          if (error instanceof ModelAllocationError) {
            sendText(response, error.status, error.message);
            return;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          sendText(response, 500, message);
        }
        return;
      }
      sendText(response, 405, "Method not allowed");
      return;
    }

    if (method !== "GET") {
      sendText(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/api/model-allocations") {
      try {
        const payload = await listModelAllocations(options.profilesDirectory);
        send(
          response,
          200,
          "application/json; charset=utf-8",
          `${JSON.stringify(payload)}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendText(response, 500, message);
      }
      return;
    }

    if (url.pathname === "/api/runs") {
      const rows = await listRunSummaries(options.profilesDirectory);
      send(
        response,
        200,
        "application/json; charset=utf-8",
        `${JSON.stringify({ runs: rows.map(toRunListItem) })}\n`,
      );
      return;
    }
    if (url.pathname === "/api/cost-stats") {
      const periodParam = url.searchParams.get("period");
      const period = parseCostPeriod(periodParam ?? "7d");
      if (!period) {
        sendText(response, 400, "period must be 7d");
        return;
      }
      const modelParsed = parseCostModelFilter({
        model: url.searchParams.get("model"),
        provider: url.searchParams.get("provider"),
      });
      if (!modelParsed.ok) {
        sendText(response, 400, modelParsed.error);
        return;
      }
      const profiles = url.searchParams
        .getAll("profile")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
      for (const profileId of profiles) {
        if (!isProfileId(profileId)) {
          sendText(response, 400, `Invalid profile id ${profileId}`);
          return;
        }
      }
      try {
        const stats = await buildCostStats({
          profilesDirectory: options.profilesDirectory,
          period,
          modelFilter: modelParsed.filter,
          ...(profiles.length > 0 ? { profiles } : {}),
        });
        send(
          response,
          200,
          "application/json; charset=utf-8",
          `${JSON.stringify(stats)}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendText(response, 500, message);
      }
      return;
    }
    if (url.pathname === "/api/profiles") {
      const profiles = await listProfileViews(options.profilesDirectory);
      send(
        response,
        200,
        "application/json; charset=utf-8",
        `${JSON.stringify({ profiles })}\n`,
      );
      return;
    }
    const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
    if (profileMatch) {
      const profileId = decodeURIComponent(profileMatch[1] ?? "");
      if (!isProfileId(profileId)) {
        sendText(response, 404, "Unknown profile");
        return;
      }
      try {
        const profile = await getProfileDetailView(
          options.profilesDirectory,
          profileId,
        );
        if (!profile) {
          sendText(response, 404, `Unknown profile ${profileId}`);
          return;
        }
        send(
          response,
          200,
          "application/json; charset=utf-8",
          `${JSON.stringify({ profile })}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendText(response, 500, message);
      }
      return;
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const runId = decodeURIComponent(match[1] ?? "");
      if (!runIdPattern.test(runId)) {
        sendText(response, 404, "Unknown run");
        return;
      }
      const summary = await findRunSummary(options.profilesDirectory, runId);
      if (!summary?.runId) {
        sendText(response, 404, `Unknown run ${runId}`);
        return;
      }
      if (!summary.sessionPath || !summary.hasSessionFile) {
        sendText(response, 404, `No Pi session JSONL for ${runId}`);
        return;
      }
      const cacheKey = `${summary.sessionPath}:${summary.runId}`;
      const cacheable =
        summary.state === "succeeded" || summary.state === "failed";
      const cached = cache.get(runId);
      if (cacheable && cached?.key === cacheKey) {
        send(response, 200, "text/html; charset=utf-8", cached.html);
        return;
      }
      let pending = inflight.get(runId);
      if (!pending) {
        pending = exportSessionHtml({
          executable: options.piExecutable,
          sessionDirectory: options.sessionDirectory,
          runId: summary.runId,
          sessionPath: summary.sessionPath,
          systemPrompt: await beaconOwnedSystemPrompt(
            summary,
            options.profilesDirectory,
          ),
          timeoutMs: options.exportTimeoutMs,
        }).finally(() => {
          inflight.delete(runId);
        });
        inflight.set(runId, pending);
      }
      const html = await pending;
      if (cacheable) cache.set(runId, { key: cacheKey, html });
      send(response, 200, "text/html; charset=utf-8", html);
      return;
    }
    if (await sendStaticFile(request, response, uiDirectory, url.pathname)) {
      return;
    }
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/runs/")
    ) {
      if (await sendStaticFile(request, response, uiDirectory, "/index.html")) {
        return;
      }
    }
    sendText(response, 404, "Not found");
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        sendText(response, 500, message);
        return;
      }
      response.destroy(error instanceof Error ? error : new Error(message));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.listen, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : options.port;

  return {
    port,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
