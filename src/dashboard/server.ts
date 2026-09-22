import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProfile } from "../config/profile.js";
import {
  type AgentSystemPromptTrigger,
  buildAgentSystemPrompt,
} from "../runtime/system-prompt.js";
import { exportSessionHtml } from "./export.js";
import {
  findRunSummary,
  listRunSummaries,
  type RunSummary,
  runIdPattern,
  toRunListItem,
} from "./records.js";
import { sendStaticFile } from "./static.js";

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
  if (summary.kind === "feishu_message") {
    return { kind: "feishu_message", notify: false };
  }
  return { kind: "manual", notify: summary.hasNotifyTarget };
}

async function beaconOwnedSystemPrompt(
  summary: RunSummary,
  profilesDirectory: string,
): Promise<string | undefined> {
  if (summary.systemPrompt) return summary.systemPrompt;
  try {
    return buildAgentSystemPrompt(
      await loadProfile(summary.profileId, profilesDirectory),
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
    if (request.method !== "GET") {
      sendText(response, 405, "Method not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://beacon.local");
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
          feedback: summary.feedback,
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
