import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";

import type {
  FeedbackRecord,
  FinalOutcomeContent,
  ObservabilityFeedbackRecord,
} from "../domain/types.js";
import {
  completeOutcome,
  mergeOutcome,
  type OutcomePatch,
  parseOutcomePatch,
} from "../outcome/content.js";
import { PiRuntimeError, runPiAgent } from "./pi-rpc.js";
import {
  assertSupervisorOrThrow,
  lifecyclePaths,
  type PiWorkerCompletion,
  readWorkerRequest,
  writeWorkerCompletion,
  writeWorkerHeartbeat,
} from "./pi-worker-lifecycle.js";
import { DEFAULT_ORPHAN_AFTER_MS } from "./supervisor-lease.js";

type SubmissionRecord = {
  outcome?: OutcomePatch | undefined;
  feedbackSubmittedAt?: string | undefined;
  observabilityFeedbackSubmittedAt?: string | undefined;
};

function respond(socket: { end(data: string): void }, response: object): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function startWorkerOutcomeServer(
  socketPath: string,
  runToken: string,
  maxRequestBytes = 1024 * 1024,
): Promise<{
  take(): FinalOutcomeContent;
  takeFeedback(): FeedbackRecord | undefined;
  takeObservabilityFeedback(): ObservabilityFeedbackRecord | undefined;
  hasReply(): boolean;
  close(): Promise<void>;
}> {
  await rm(socketPath, { force: true });
  const record: SubmissionRecord = {};
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let finished = false;
    socket.on("data", (chunk: string) => {
      if (finished) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxRequestBytes) {
        finished = true;
        respond(socket, {
          ok: false,
          error: "Outcome submission request is too large",
        });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finished = true;
      let request: unknown;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        respond(socket, { ok: false, error: "invalid JSON request" });
        return;
      }
      if (
        typeof request !== "object" ||
        request === null ||
        !("runToken" in request) ||
        !("outcome" in request) ||
        typeof request.runToken !== "string"
      ) {
        respond(socket, {
          ok: false,
          error: "runToken and outcome are required",
        });
        return;
      }
      if (request.runToken !== runToken) {
        respond(socket, { ok: false, error: "unknown Run Capability" });
        return;
      }
      let patch: OutcomePatch;
      try {
        patch = parseOutcomePatch(request.outcome);
      } catch (error) {
        respond(socket, {
          ok: false,
          error: `invalid Final Outcome: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
      try {
        const previous = record.outcome;
        record.outcome = mergeOutcome(record.outcome, patch);
        if (patch.feedback && !previous?.feedback) {
          record.feedbackSubmittedAt = new Date().toISOString();
        }
        if (patch.observabilityFeedback && !previous?.observabilityFeedback) {
          record.observabilityFeedbackSubmittedAt = new Date().toISOString();
        }
      } catch (error) {
        respond(socket, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      respond(socket, { ok: true });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  return {
    take(): FinalOutcomeContent {
      return completeOutcome(record.outcome ?? {});
    },
    takeFeedback(): FeedbackRecord | undefined {
      const items = record.outcome?.feedback?.items;
      if (!items || record.feedbackSubmittedAt === undefined) return undefined;
      return { items, submittedAt: record.feedbackSubmittedAt };
    },
    takeObservabilityFeedback(): ObservabilityFeedbackRecord | undefined {
      const items = record.outcome?.observabilityFeedback?.items;
      if (!items || record.observabilityFeedbackSubmittedAt === undefined) {
        return undefined;
      }
      return { items, submittedAt: record.observabilityFeedbackSubmittedAt };
    },
    hasReply(): boolean {
      return record.outcome?.reply !== undefined;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(socketPath, { force: true });
    },
  };
}

async function runWorker(lifecycleDirectory: string): Promise<void> {
  const request = await readWorkerRequest(lifecycleDirectory);
  const orphanAfterMs = request.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS;
  const paths = lifecyclePaths(lifecycleDirectory);
  await mkdir(lifecycleDirectory, { recursive: true, mode: 0o700 });

  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    void writeWorkerHeartbeat(lifecycleDirectory).catch(() => undefined);
    void assertSupervisorOrThrow(request.supervisorLeasePath, orphanAfterMs)
      .then(() => undefined)
      .catch(() => {
        if (!abort.signal.aborted) abort.abort();
      });
  }, 5_000);
  heartbeat.unref?.();
  await writeWorkerHeartbeat(lifecycleDirectory);

  const outcomes = await startWorkerOutcomeServer(
    paths.outcomeSocket,
    request.runToken,
  );

  const finish = async (completion: PiWorkerCompletion): Promise<void> => {
    clearInterval(heartbeat);
    await writeWorkerCompletion(lifecycleDirectory, completion);
    await outcomes.close().catch(() => undefined);
  };

  try {
    await assertSupervisorOrThrow(request.supervisorLeasePath, orphanAfterMs);
    const result = await runPiAgent(
      {
        prompt: request.prompt,
        playbook: request.playbook,
        provider: request.provider,
        model: request.model,
        systemPrompt: request.systemPrompt,
        session: request.session,
        skills: request.skills,
        outcome: {
          socketPath: paths.outcomeSocket,
          runToken: request.runToken,
          cliPath: request.beaconCliPath,
        },
      },
      {
        executable: request.executable,
        timeoutMs: request.timeoutMs,
        terminateGraceMs: request.terminateGraceMs,
        maxFrameBytes: request.maxFrameBytes,
        environment: request.environment,
        runtimeEnvironment: request.runtimeEnvironment,
        signal: abort.signal,
      },
    );
    await finish({
      ok: true,
      result,
      outcome: outcomes.take(),
      feedback: outcomes.takeFeedback(),
      observabilityFeedback: outcomes.takeObservabilityFeedback(),
      hasReply: outcomes.hasReply(),
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const orphaned = abort.signal.aborted;
    const code = orphaned
      ? "orphan_abandoned"
      : error instanceof PiRuntimeError
        ? error.code
        : "worker_failed";
    const message = orphaned
      ? "Pi worker stopped after Beacon supervisor lease expired (orphan safety)"
      : error instanceof Error
        ? error.message
        : String(error);
    await finish({
      ok: false,
      error: { code, message },
      hasReply: outcomes.hasReply(),
      feedback: outcomes.takeFeedback(),
      observabilityFeedback: outcomes.takeObservabilityFeedback(),
      finishedAt: new Date().toISOString(),
    });
  }
}

const lifecycleDirectory = process.argv[2];
if (!lifecycleDirectory) {
  console.error("Usage: node pi-worker-main.js <lifecycle-directory>");
  process.exitCode = 1;
} else {
  runWorker(lifecycleDirectory).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await writeWorkerCompletion(lifecycleDirectory, {
        ok: false,
        error: { code: "worker_failed", message },
        hasReply: false,
        finishedAt: new Date().toISOString(),
      });
    } catch {
      console.error(`[beacon-pi-worker] fatal: ${message}`);
    }
    process.exitCode = 1;
  });
}
