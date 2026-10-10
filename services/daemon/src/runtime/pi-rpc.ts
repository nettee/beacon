import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProfileSkills } from "../config/profile.js";
import { assertRuntimeEnvironmentKey } from "../config/runtime-environment.js";
import type { OutcomeBinding } from "../outcome/server.js";

type PiOutcomeBinding = OutcomeBinding & { cliPath: string };

export type PiRunRequest = {
  prompt: string;
  playbook: string;
  provider?: string | undefined;
  model?: string | undefined;
  systemPrompt?: string | undefined;
  outcome?: PiOutcomeBinding | undefined;
  session?: { id: string; path: string; name?: string | undefined } | undefined;
  /** When set with mode explicit: `--no-skills` plus each `--skill` path. Omit = Pi discovery. */
  skills?: ProfileSkills | undefined;
};

export type PiRunResult = {
  text: string;
  provider: string;
  model: string;
  /** Final assistant stopReason when Pi settles cleanly (usually `stop`). */
  stopReason?: string | undefined;
  /** Truncation-ready last thinking text from the final assistant message. */
  thinking?: string | undefined;
};

export type PiRuntimeOptions = {
  executable?: string | undefined;
  timeoutMs?: number | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  runtimeEnvironment?: NodeJS.ProcessEnv | undefined;
  terminateGraceMs?: number | undefined;
  maxFrameBytes?: number | undefined;
};

export class PiRuntimeError extends Error {
  constructor(
    readonly code:
      | "runtime_spawn_failed"
      | "runtime_protocol_error"
      | "runtime_timeout"
      | "runtime_exit_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiRuntimeError";
  }
}

type RpcResponse = {
  type: "response";
  id?: string | undefined;
  success: boolean;
  error?: string | undefined;
};

type TextBlock = { type: "text"; text: string };

type AssistantMessage = {
  role: "assistant";
  content: unknown[];
  provider: string;
  model: string;
  stopReason: string;
  errorMessage?: string | undefined;
};

type MessageEndEvent = {
  type: "message_end";
  message: AssistantMessage;
};

type AgentSettledEvent = { type: "agent_settled" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRpcResponse(value: unknown): value is RpcResponse {
  return (
    isObject(value) &&
    value.type === "response" &&
    typeof value.success === "boolean"
  );
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isObject(value) &&
    value.role === "assistant" &&
    Array.isArray(value.content) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.stopReason === "string"
  );
}

function isMessageEndEvent(value: unknown): value is MessageEndEvent {
  return (
    isObject(value) &&
    value.type === "message_end" &&
    isAssistantMessage(value.message)
  );
}

function isAgentSettledEvent(value: unknown): value is AgentSettledEvent {
  return isObject(value) && value.type === "agent_settled";
}

function collectText(message: AssistantMessage): string {
  return message.content
    .filter(
      (block): block is TextBlock =>
        isObject(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
}

/** Collect thinking / reasoning blocks from an assistant message content array. */
export function collectThinking(content: unknown[]): string {
  return content
    .map((block) => {
      if (!isObject(block)) return "";
      if (block.type === "thinking") {
        if (typeof block.thinking === "string") return block.thinking;
        if (typeof block.text === "string") return block.text;
      }
      if (block.type === "reasoning" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
}

/** Exported for unit tests that assert argv without spawning a real Pi. */
export function buildArguments(request: PiRunRequest): string[] {
  const args = ["--mode", "rpc", "--no-approve"];
  if (request.session) {
    args.push(
      "--session-dir",
      request.session.path,
      "--session-id",
      request.session.id,
    );
    if (request.session.name) args.push("--name", request.session.name);
  } else {
    args.push("--no-session");
  }
  if (request.provider) args.push("--provider", request.provider);
  if (request.model) args.push("--model", request.model);
  if (request.systemPrompt) args.push("--system-prompt", request.systemPrompt);
  if (request.skills?.mode === "explicit") {
    args.push("--no-skills");
    for (const skillPath of request.skills.paths) {
      args.push("--skill", skillPath);
    }
  }
  if (request.outcome) {
    args.push(
      "--extension",
      fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../dist/runtime/pi-outcome-extension.js"
            : "./pi-outcome-extension.js",
          import.meta.url,
        ),
      ),
    );
  }
  return args;
}

const inheritedEnvironmentKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "GH_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "PI_OFFLINE",
  "PI_TELEMETRY",
] as const;

function buildPiEnvironment(
  outcome?: PiOutcomeBinding,
  configured: NodeJS.ProcessEnv = {},
  runtimeEnvironment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(runtimeEnvironment)) {
    assertRuntimeEnvironmentKey(key);
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(configured)) {
    if (
      !inheritedEnvironmentKeys.includes(
        key as (typeof inheritedEnvironmentKeys)[number],
      )
    ) {
      throw new Error(`Pi environment key is not allowlisted: ${key}`);
    }
    if (value !== undefined) environment[key] = value;
  }
  if (outcome) {
    environment.BEACON_OUTCOME_SOCKET = outcome.socketPath;
    environment.BEACON_RUN_TOKEN = outcome.runToken;
    environment.BEACON_CLI_PATH = outcome.cliPath;
  }
  return environment;
}

/** Pi stderr that is normal session bootstrap, not a failure cause. */
const BENIGN_PI_STDERR_PATTERNS: readonly RegExp[] = [
  /^Warning:\s*No project session found with id '[^']+'; creating a new session with that id\.?\s*$/i,
];

/**
 * Drop known-benign Pi stderr lines (e.g. "No project session found… creating
 * a new session") so they are not pasted into failure summaries as if they were
 * the root cause.
 */
export function sanitizePiStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return !BENIGN_PI_STDERR_PATTERNS.some((pattern) =>
        pattern.test(trimmed),
      );
    })
    .join("\n")
    .trim();
}

/** Human-readable timeout budget for operator-facing messages. */
export function formatTimeoutDuration(timeoutMs: number): string {
  if (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs % 60_000 === 0
  ) {
    return `${timeoutMs / 60_000}min (${timeoutMs}ms)`;
  }
  if (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs % 1_000 === 0
  ) {
    return `${timeoutMs / 1_000}s (${timeoutMs}ms)`;
  }
  return `${timeoutMs}ms`;
}

/** Stable English note when Outcome was submitted before hard timeout. */
export const RUNTIME_TIMEOUT_OUTCOME_SUBMITTED_NOTE =
  "Final Outcome was already submitted before timeout; Beacon still marked the Run failed because the Pi process did not exit in time";

/** Stable English note when Outcome was missing at hard timeout. */
export const RUNTIME_TIMEOUT_OUTCOME_MISSING_NOTE =
  "No Final Outcome was submitted before timeout";

/**
 * Beacon-owned hard timeout summary. Makes clear this is Beacon's Run limit,
 * not a Pi "session not found" failure.
 */
export function formatRuntimeTimeoutMessage(
  timeoutMs: number,
  stderr: string,
): string {
  const duration = formatTimeoutDuration(timeoutMs);
  const detail = sanitizePiStderr(stderr);
  return `Beacon Run hard timeout after ${duration}: Pi process did not exit in time${
    detail ? `. Remaining stderr: ${detail}` : ""
  }`;
}

function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const detail = sanitizePiStderr(stderr);
  return new PiRuntimeError(
    "runtime_exit_failed",
    `Pi process exited before the Run settled (code=${String(code)} signal=${String(signal)})${detail ? `: ${detail}` : ""}`,
  );
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  terminateGraceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, terminateGraceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Read NDJSON frames from Pi stdout with a hard per-frame byte cap.
 *
 * Oversized frames (for example tool events carrying multi-MB stdout) are
 * discarded through the next newline instead of failing the whole Run. Beacon
 * only needs prompt responses, `message_end`, and `agent_settled`; intermediate
 * tool frames are ignored anyway, and Pi already truncates tool output for the
 * model. The cap still bounds parse/buffer memory — we never raise it here.
 */
export function createCappedNdjsonReader(
  maxFrameBytes: number,
  onFrame: (line: string) => void,
): {
  push: (chunk: Buffer) => void;
  close: () => void;
  readonly skippedOversizedFrames: number;
} {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new Error("Pi RPC frame limit must be a positive integer");
  }

  const chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let discarding = false;
  let closed = false;
  let skippedOversizedFrames = 0;

  const resetBuffer = (): void => {
    chunks.length = 0;
    bufferedBytes = 0;
  };

  const emitFrame = (): void => {
    const line = Buffer.concat(chunks, bufferedBytes).toString("utf8");
    resetBuffer();
    onFrame(line);
  };

  const push = (chunk: Buffer): void => {
    if (closed || chunk.length === 0) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (discarding) {
        const nl = chunk.indexOf(10, offset);
        if (nl === -1) return;
        discarding = false;
        offset = nl + 1;
        continue;
      }

      const nl = chunk.indexOf(10, offset);
      const end = nl === -1 ? chunk.length : nl;
      const pieceLen = end - offset;

      if (bufferedBytes + pieceLen > maxFrameBytes) {
        skippedOversizedFrames += 1;
        resetBuffer();
        if (nl === -1) {
          discarding = true;
          return;
        }
        offset = nl + 1;
        continue;
      }

      if (pieceLen > 0) {
        chunks.push(chunk.subarray(offset, end));
        bufferedBytes += pieceLen;
      }

      if (nl === -1) return;
      emitFrame();
      offset = nl + 1;
    }
  };

  return {
    push,
    close: () => {
      closed = true;
      resetBuffer();
      discarding = false;
    },
    get skippedOversizedFrames() {
      return skippedOversizedFrames;
    },
  };
}

export async function runPiAgent(
  request: PiRunRequest,
  options: PiRuntimeOptions = {},
): Promise<PiRunResult> {
  if (!request.prompt.trim())
    throw new Error("Pi Run prompt must not be empty");
  if (!request.playbook.trim())
    throw new Error("Pi Run playbook must not be empty");
  if ((request.provider === undefined) !== (request.model === undefined)) {
    throw new Error(
      "Pi Run provider and model must either both be set or both be omitted",
    );
  }
  if (request.session) {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(request.session.id)
    ) {
      throw new Error("Pi session ID is invalid");
    }
    if (!isAbsolute(request.session.path)) {
      throw new Error("Pi session path must be absolute");
    }
    if (request.session.name !== undefined && !request.session.name.trim()) {
      throw new Error("Pi session name must not be empty");
    }
    try {
      await mkdir(request.session.path, { recursive: true, mode: 0o700 });
      await chmod(request.session.path, 0o700);
    } catch (error) {
      throw new PiRuntimeError(
        "runtime_spawn_failed",
        `Cannot prepare Pi session directory: ${request.session.path}`,
        { cause: error },
      );
    }
  }

  const executable = options.executable ?? "pi";
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const terminateGraceMs = options.terminateGraceMs ?? 1_000;
  const maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Pi Run timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(terminateGraceMs) || terminateGraceMs <= 0) {
    throw new Error("Pi termination grace must be a positive integer");
  }
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new Error("Pi RPC frame limit must be a positive integer");
  }

  const child = spawn(executable, buildArguments(request), {
    cwd: request.playbook,
    env: buildPiEnvironment(
      request.outcome,
      options.environment,
      options.runtimeEnvironment,
    ),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let finalMessage: AssistantMessage | undefined;
  let promptAccepted = false;
  let finished = false;
  let frames: ReturnType<typeof createCappedNdjsonReader> | undefined;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-64 * 1024);
  });

  try {
    return await new Promise<PiRunResult>((resolve, reject) => {
      const fail = (error: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(error);
      };

      const timer = setTimeout(
        () =>
          fail(
            new PiRuntimeError(
              "runtime_timeout",
              formatRuntimeTimeoutMessage(timeoutMs, stderr),
            ),
          ),
        timeoutMs,
      );

      const handleFrame = (line: string): void => {
        if (finished) return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          fail(
            new PiRuntimeError(
              "runtime_protocol_error",
              `Pi emitted invalid RPC JSON: ${line}`,
            ),
          );
          return;
        }

        if (isRpcResponse(value) && value.id === "run-prompt") {
          if (!value.success) {
            fail(
              new PiRuntimeError(
                "runtime_protocol_error",
                `Pi rejected the prompt: ${value.error ?? "unknown RPC error"}`,
              ),
            );
            return;
          }
          promptAccepted = true;
        }
        if (isMessageEndEvent(value)) {
          finalMessage = value.message;
          return;
        }
        if (!isAgentSettledEvent(value)) return;

        if (!promptAccepted) {
          fail(
            new PiRuntimeError(
              "runtime_protocol_error",
              "Pi settled without accepting the prompt RPC command",
            ),
          );
          return;
        }
        if (!finalMessage) {
          fail(
            new PiRuntimeError(
              "runtime_protocol_error",
              "Pi settled without an assistant message_end event",
            ),
          );
          return;
        }
        if (finalMessage.stopReason !== "stop") {
          fail(
            new PiRuntimeError(
              "runtime_exit_failed",
              `Pi ended with stopReason=${finalMessage.stopReason}${finalMessage.errorMessage ? `: ${finalMessage.errorMessage}` : ""}`,
            ),
          );
          return;
        }

        try {
          const text = collectText(finalMessage);
          if (!request.outcome && !text) {
            fail(new Error("Pi completed without a textual final response"));
            return;
          }
          const thinking = collectThinking(finalMessage.content);
          const result: PiRunResult = {
            text,
            provider: finalMessage.provider,
            model: finalMessage.model,
            stopReason: finalMessage.stopReason,
            ...(thinking ? { thinking } : {}),
          };
          finished = true;
          clearTimeout(timer);
          resolve(result);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

      frames = createCappedNdjsonReader(maxFrameBytes, handleFrame);
      child.stdout.on("data", (chunk: Buffer) => {
        frames?.push(chunk);
      });

      child.once("error", (error) =>
        fail(
          new PiRuntimeError(
            "runtime_spawn_failed",
            `Failed to start Pi: ${error.message}`,
            {
              cause: error,
            },
          ),
        ),
      );
      child.once("exit", (code, signal) => {
        if (!finished) fail(describeExit(code, signal, stderr));
      });

      child.stdin.on("error", (error) =>
        fail(
          new PiRuntimeError(
            "runtime_protocol_error",
            `Failed to write Pi RPC command: ${error.message}`,
            { cause: error },
          ),
        ),
      );
      child.stdin.write(
        `${JSON.stringify({ id: "run-prompt", type: "prompt", message: request.prompt })}\n`,
      );
    });
  } finally {
    frames?.close();
    await stopProcess(child, terminateGraceMs);
  }
}
