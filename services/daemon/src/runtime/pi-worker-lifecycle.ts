import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileSkills } from "../config/profile.js";
import type {
  FeedbackRecord,
  FinalOutcomeContent,
  ObservabilityFeedbackRecord,
} from "../domain/types.js";
import type { PiRunResult, PiRuntimeOptions } from "./pi-rpc.js";
import {
  DEFAULT_ORPHAN_AFTER_MS,
  isSupervisorLeaseFresh,
} from "./supervisor-lease.js";

/**
 * Usable AF_UNIX path length on macOS (`sun_path` is 104 including NUL).
 * Enforced on all platforms so Linux CI catches oversize paths too.
 */
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;

export type PiWorkerRequest = {
  prompt: string;
  playbook: string;
  provider?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  systemPrompt?: string | undefined;
  session?: { id: string; path: string; name?: string | undefined } | undefined;
  skills?: ProfileSkills | undefined;
  beaconCliPath: string;
  runToken: string;
  /** Short absolute path under ~/.beacon/state/outcomes/<16hex>.sock */
  outcomeSocketPath: string;
  supervisorLeasePath: string;
  orphanAfterMs?: number | undefined;
  executable?: string | undefined;
  timeoutMs?: number | undefined;
  terminateGraceMs?: number | undefined;
  maxFrameBytes?: number | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  runtimeEnvironment?: NodeJS.ProcessEnv | undefined;
};

/** Stable, short per-run Outcome socket under the daemon outcomes directory. */
export function resolveWorkerOutcomeSocketPath(
  outcomesDirectory: string,
  runId: string,
): string {
  if (!isAbsolute(outcomesDirectory)) {
    throw new Error("Worker outcome socket directory must be absolute");
  }
  if (!runId) {
    throw new Error("Worker outcome socket requires a run id");
  }
  const shortId = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  const socketPath = join(outcomesDirectory, `${shortId}.sock`);
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Worker outcome socket path exceeds Unix sun_path limit (${bytes} > ${UNIX_SOCKET_PATH_MAX_BYTES} bytes): ${socketPath}`,
    );
  }
  return socketPath;
}

export type PiWorkerCompletion =
  | {
      ok: true;
      result: PiRunResult;
      outcome: FinalOutcomeContent;
      feedback?: FeedbackRecord | undefined;
      observabilityFeedback?: ObservabilityFeedbackRecord | undefined;
      hasReply: boolean;
      finishedAt: string;
    }
  | {
      ok: false;
      error: {
        code:
          | "runtime_spawn_failed"
          | "runtime_protocol_error"
          | "runtime_timeout"
          | "runtime_exit_failed"
          | "orphan_abandoned"
          | "worker_failed";
        message: string;
      };
      hasReply: boolean;
      /** Present when the Agent already submitted a Final Outcome before the error. */
      outcome?: FinalOutcomeContent | undefined;
      feedback?: FeedbackRecord | undefined;
      observabilityFeedback?: ObservabilityFeedbackRecord | undefined;
      finishedAt: string;
    };

export type AgentRuntimeHandle = {
  workerPid: number;
  lifecycleDirectory: string;
  runToken: string;
  supervisorLeasePath: string;
  orphanAfterMs: number;
};

const REQUEST_FILE = "request.json";
const COMPLETION_FILE = "completion.json";
const HEARTBEAT_FILE = "worker.heartbeat";
const PID_FILE = "worker.pid";

export function lifecyclePaths(lifecycleDirectory: string) {
  return {
    request: join(lifecycleDirectory, REQUEST_FILE),
    completion: join(lifecycleDirectory, COMPLETION_FILE),
    heartbeat: join(lifecycleDirectory, HEARTBEAT_FILE),
    pid: join(lifecycleDirectory, PID_FILE),
    /** @deprecated 0.6.0 bound here; 0.6.1+ uses resolveWorkerOutcomeSocketPath. */
    legacyOutcomeSocket: join(lifecycleDirectory, "outcomes.sock"),
  };
}

export async function prepareLifecycleDirectory(
  lifecycleDirectory: string,
  options: { outcomeSocketPath?: string | undefined } = {},
): Promise<void> {
  if (!isAbsolute(lifecycleDirectory)) {
    throw new Error("Pi worker lifecycle directory must be absolute");
  }
  await mkdir(lifecycleDirectory, { recursive: true, mode: 0o700 });
  await chmod(lifecycleDirectory, 0o700);
  const paths = lifecyclePaths(lifecycleDirectory);
  await rm(paths.completion, { force: true });
  await rm(paths.heartbeat, { force: true });
  await rm(paths.pid, { force: true });
  await rm(paths.legacyOutcomeSocket, { force: true });
  if (options.outcomeSocketPath) {
    if (!isAbsolute(options.outcomeSocketPath)) {
      throw new Error("Worker outcome socket path must be absolute");
    }
    await mkdir(dirname(options.outcomeSocketPath), {
      recursive: true,
      mode: 0o700,
    });
    await rm(options.outcomeSocketPath, { force: true });
  }
}

export async function writeWorkerRequest(
  lifecycleDirectory: string,
  request: PiWorkerRequest,
): Promise<void> {
  if (!request.outcomeSocketPath || !isAbsolute(request.outcomeSocketPath)) {
    throw new Error("Pi worker request requires an absolute outcomeSocketPath");
  }
  await prepareLifecycleDirectory(lifecycleDirectory, {
    outcomeSocketPath: request.outcomeSocketPath,
  });
  const temporary = `${lifecyclePaths(lifecycleDirectory).request}.tmp`;
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, lifecyclePaths(lifecycleDirectory).request);
}

export async function readWorkerRequest(
  lifecycleDirectory: string,
): Promise<PiWorkerRequest> {
  const raw = JSON.parse(
    await readFile(lifecyclePaths(lifecycleDirectory).request, "utf8"),
  ) as PiWorkerRequest;
  if (
    !raw.beaconCliPath ||
    !raw.runToken ||
    !raw.supervisorLeasePath ||
    !raw.outcomeSocketPath
  ) {
    throw new Error("Pi worker request is missing required fields");
  }
  if (!isAbsolute(raw.outcomeSocketPath)) {
    throw new Error("Pi worker outcomeSocketPath must be absolute");
  }
  return raw;
}

export async function writeWorkerHeartbeat(
  lifecycleDirectory: string,
): Promise<void> {
  const temporary = `${lifecyclePaths(lifecycleDirectory).heartbeat}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, lifecyclePaths(lifecycleDirectory).heartbeat);
}

export async function writeWorkerPid(
  lifecycleDirectory: string,
  pid: number,
): Promise<void> {
  await writeFile(lifecyclePaths(lifecycleDirectory).pid, `${pid}\n`, {
    mode: 0o600,
  });
}

export async function writeWorkerCompletion(
  lifecycleDirectory: string,
  completion: PiWorkerCompletion,
): Promise<void> {
  const temporary = `${lifecyclePaths(lifecycleDirectory).completion}.tmp`;
  await writeFile(temporary, `${JSON.stringify(completion, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, lifecyclePaths(lifecycleDirectory).completion);
}

export async function readWorkerCompletion(
  lifecycleDirectory: string,
): Promise<PiWorkerCompletion | undefined> {
  try {
    return JSON.parse(
      await readFile(lifecyclePaths(lifecycleDirectory).completion, "utf8"),
    ) as PiWorkerCompletion;
  } catch {
    return undefined;
  }
}

export async function readWorkerHeartbeat(
  lifecycleDirectory: string,
): Promise<{ pid: number; updatedAt: string } | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(lifecyclePaths(lifecycleDirectory).heartbeat, "utf8"),
    ) as unknown;
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("pid" in raw) ||
      !("updatedAt" in raw) ||
      typeof raw.pid !== "number" ||
      typeof raw.updatedAt !== "string"
    ) {
      return undefined;
    }
    return { pid: raw.pid, updatedAt: raw.updatedAt };
  } catch {
    return undefined;
  }
}

export async function readWorkerPid(
  lifecycleDirectory: string,
): Promise<number | undefined> {
  try {
    const raw = (
      await readFile(lifecyclePaths(lifecycleDirectory).pid, "utf8")
    ).trim();
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isWorkerAdoptable(
  handle: Pick<
    AgentRuntimeHandle,
    "workerPid" | "lifecycleDirectory" | "orphanAfterMs"
  >,
  nowMs = Date.now(),
  heartbeatMaxAgeMs = 60_000,
): Promise<boolean> {
  // Prefer completion.json even when the worker has already exited: a finished
  // Run across a Beacon restart must stay finalizable as succeeded/failed.
  const completion = await readWorkerCompletion(handle.lifecycleDirectory);
  if (completion) return true;
  if (!isProcessAlive(handle.workerPid)) return false;
  const heartbeat = await readWorkerHeartbeat(handle.lifecycleDirectory);
  if (!heartbeat) return false;
  const updatedAt = Date.parse(heartbeat.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  return nowMs - updatedAt <= heartbeatMaxAgeMs;
}

export async function waitForWorkerCompletion(
  lifecycleDirectory: string,
  options: {
    pollIntervalMs?: number | undefined;
    abortSignal?: AbortSignal | undefined;
  } = {},
): Promise<PiWorkerCompletion> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  for (;;) {
    if (options.abortSignal?.aborted) {
      throw new Error("Waiting for Pi worker completion was aborted");
    }
    const completion = await readWorkerCompletion(lifecycleDirectory);
    if (completion) return completion;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

export function resolvePiWorkerMainPath(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../../dist/runtime/pi-worker-main.js"
        : "./pi-worker-main.js",
      import.meta.url,
    ),
  );
}

export type SpawnDetachedWorkerOptions = PiRuntimeOptions & {
  beaconCliPath: string;
  runToken: string;
  supervisorLeasePath: string;
  orphanAfterMs?: number | undefined;
  workerMainPath?: string | undefined;
};

export async function spawnDetachedPiWorker(
  lifecycleDirectory: string,
  request: Omit<
    PiWorkerRequest,
    | "beaconCliPath"
    | "runToken"
    | "supervisorLeasePath"
    | "orphanAfterMs"
    | "executable"
    | "timeoutMs"
    | "terminateGraceMs"
    | "maxFrameBytes"
    | "environment"
    | "runtimeEnvironment"
  > & {
    prompt: string;
    playbook: string;
  },
  options: SpawnDetachedWorkerOptions,
): Promise<AgentRuntimeHandle> {
  const orphanAfterMs = options.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS;
  const workerRequest: PiWorkerRequest = {
    ...request,
    beaconCliPath: options.beaconCliPath,
    runToken: options.runToken,
    supervisorLeasePath: options.supervisorLeasePath,
    orphanAfterMs,
    executable: options.executable,
    timeoutMs: options.timeoutMs,
    terminateGraceMs: options.terminateGraceMs,
    maxFrameBytes: options.maxFrameBytes,
    environment: options.environment,
    runtimeEnvironment: options.runtimeEnvironment,
  };
  await writeWorkerRequest(lifecycleDirectory, workerRequest);

  const workerMainPath = options.workerMainPath ?? resolvePiWorkerMainPath();
  try {
    await access(workerMainPath);
  } catch (error) {
    throw new Error(
      `Pi worker entry is missing (build the daemon first): ${workerMainPath}`,
      { cause: error },
    );
  }

  const child = spawn(process.execPath, [workerMainPath, lifecycleDirectory], {
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
    },
  });
  if (child.pid === undefined) {
    throw new Error("Failed to spawn detached Pi worker (no pid)");
  }
  child.unref();
  await writeWorkerPid(lifecycleDirectory, child.pid);
  return {
    workerPid: child.pid,
    lifecycleDirectory,
    runToken: options.runToken,
    supervisorLeasePath: options.supervisorLeasePath,
    orphanAfterMs,
  };
}

/** Stop a still-living worker (orphan / abandon). Best-effort. */
export function signalWorker(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

export async function assertSupervisorOrThrow(
  supervisorLeasePath: string,
  orphanAfterMs: number,
): Promise<void> {
  if (!(await isSupervisorLeaseFresh(supervisorLeasePath, orphanAfterMs))) {
    throw new Error(
      `No Beacon supervisor lease for ${orphanAfterMs}ms; abandoning orphan Pi worker`,
    );
  }
}
