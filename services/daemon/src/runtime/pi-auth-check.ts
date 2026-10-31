import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PiAuthCheckStatus = "ready" | "not_ready" | "invalid";

export type PiAuthCheckResult = {
  /** True only when `pi auth check` returned `status: "ready"`. */
  ready: boolean;
  /**
   * True when the check ran and returned a parseable Pi auth status.
   * False when the executable is missing, timed out, or output is unusable —
   * callers should fail open (do not block PUT; treat display as ready).
   */
  conclusive: boolean;
  status?: PiAuthCheckStatus | undefined;
  reason?: string | undefined;
};

export type PiAuthCheckTarget = {
  provider: string;
  /** Model id (without thinking). */
  id: string;
};

export type CheckPiAuthReadyOptions = {
  executable: string;
  codingAgentDirectory: string;
  /** Merged into the child env (e.g. Beacon `runtime.env` API keys). */
  runtimeEnvironment?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
};

type AuthCheckJson = {
  status?: unknown;
  provider?: unknown;
  reason?: unknown;
  authType?: unknown;
};

function parseAuthCheckStdout(stdout: string): AuthCheckJson | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("{"));
  if (!line) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as AuthCheckJson;
  } catch {
    return undefined;
  }
}

function fromJson(parsed: AuthCheckJson): PiAuthCheckResult {
  const status = parsed.status;
  if (status === "ready") {
    return { ready: true, conclusive: true, status: "ready" };
  }
  if (status === "not_ready" || status === "invalid") {
    return {
      ready: false,
      conclusive: true,
      status,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  }
  return { ready: false, conclusive: false };
}

/**
 * Read-only Pi credential/model preflight (`pi auth check --json --no-refresh`).
 * Does not refresh OAuth or mutate `auth.json`.
 */
export async function checkPiAuthReady(
  target: PiAuthCheckTarget,
  options: CheckPiAuthReadyOptions,
): Promise<PiAuthCheckResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.runtimeEnvironment ?? {}),
    PI_CODING_AGENT_DIR: options.codingAgentDirectory,
  };
  try {
    const { stdout } = await execFileAsync(
      options.executable,
      [
        "auth",
        "check",
        "--provider",
        target.provider,
        "--model",
        target.id,
        "--json",
        "--no-refresh",
      ],
      {
        timeout: timeoutMs,
        env,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    const parsed = parseAuthCheckStdout(stdout);
    if (!parsed) return { ready: false, conclusive: false };
    return fromJson(parsed);
  } catch (error: unknown) {
    // exit 1 (not_ready) / 2 (invalid) still often print JSON on stdout.
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      const parsed = parseAuthCheckStdout(error.stdout);
      if (parsed) return fromJson(parsed);
    }
    return { ready: false, conclusive: false };
  }
}

export type ChoiceAuthProbe = {
  provider: string;
  id: string;
};

/**
 * Deduplicate by provider+id (thinking does not affect auth) and probe in parallel.
 */
export async function probeChoiceAuthReady(
  choices: ReadonlyArray<ChoiceAuthProbe>,
  check: (
    target: PiAuthCheckTarget,
  ) => Promise<PiAuthCheckResult> = async () => ({
    ready: true,
    conclusive: false,
  }),
): Promise<Map<string, PiAuthCheckResult>> {
  const identityKey = (choice: ChoiceAuthProbe): string =>
    `${choice.provider}\0${choice.id}`;
  const unique = new Map<string, ChoiceAuthProbe>();
  for (const choice of choices) {
    const key = identityKey(choice);
    if (!unique.has(key)) unique.set(key, choice);
  }
  const results = new Map<string, PiAuthCheckResult>();
  await Promise.all(
    [...unique.entries()].map(async ([key, choice]) => {
      results.set(key, await check(choice));
    }),
  );
  return results;
}

export function authIdentityKey(choice: ChoiceAuthProbe): string {
  return `${choice.provider}\0${choice.id}`;
}

/**
 * Build a checker bound to the host Pi executable / coding-agent dir.
 * When the probe is inconclusive, callers should treat the model as ready
 * for display and skip PUT rejection (fail open).
 */
export function createPiAuthReadyChecker(
  options: CheckPiAuthReadyOptions,
): (target: PiAuthCheckTarget) => Promise<PiAuthCheckResult> {
  return (target) => checkPiAuthReady(target, options);
}
