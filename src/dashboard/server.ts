import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { exportSessionHtml } from "./export.js";
import { renderRunListPage } from "./page.js";
import { findRunSummary, listRunSummaries, runIdPattern } from "./records.js";

export type DashboardOptions = {
  listen: string;
  port: number;
  profilesDirectory: string;
  sessionDirectory: string;
  piExecutable: string;
  exportTimeoutMs?: number | undefined;
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

export async function startDashboard(
  options: DashboardOptions,
): Promise<DashboardServer> {
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<string>>();

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method !== "GET") {
      sendText(response, 405, "Method not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://beacon.local");
    if (url.pathname === "/") {
      const rows = await listRunSummaries(options.profilesDirectory);
      send(response, 200, "text/html; charset=utf-8", renderRunListPage(rows));
      return;
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      sendText(response, 404, "Not found");
      return;
    }
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
        timeoutMs: options.exportTimeoutMs,
      }).finally(() => {
        inflight.delete(runId);
      });
      inflight.set(runId, pending);
    }
    const html = await pending;
    if (cacheable) cache.set(runId, { key: cacheKey, html });
    send(response, 200, "text/html; charset=utf-8", html);
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
