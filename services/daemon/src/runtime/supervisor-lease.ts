import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SupervisorLease = {
  pid: number;
  updatedAt: string;
};

export const DEFAULT_ORPHAN_AFTER_MS = 120_000;
export const DEFAULT_LEASE_INTERVAL_MS = 10_000;

export async function writeSupervisorLease(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lease: SupervisorLease = {
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  // Unique tmp per attempt — a fixed `${pid}.tmp` races when overlapping
  // writes rename the same path away (ENOENT on the second rename).
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readSupervisorLease(
  path: string,
): Promise<SupervisorLease | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
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

/** True when a supervisor has refreshed the lease within orphanAfterMs. */
export async function isSupervisorLeaseFresh(
  path: string,
  orphanAfterMs: number,
  nowMs = Date.now(),
): Promise<boolean> {
  const lease = await readSupervisorLease(path);
  if (!lease) return false;
  const updatedAt = Date.parse(lease.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  return nowMs - updatedAt <= orphanAfterMs;
}

export type SupervisorLeaseHandle = {
  stop(): void;
};

export type SupervisorLeaseWriterOptions = {
  intervalMs?: number;
  /** Used to escalate logs when refresh has been failing near orphan threshold. */
  orphanAfterMs?: number;
  /** Injected for tests. */
  write?: (path: string) => Promise<void>;
  now?: () => number;
  logError?: (message: string) => void;
};

/** Refresh the lease until stop(). Writes once immediately. */
export function startSupervisorLeaseWriter(
  path: string,
  intervalMsOrOptions:
    | number
    | SupervisorLeaseWriterOptions = DEFAULT_LEASE_INTERVAL_MS,
): SupervisorLeaseHandle {
  const options: SupervisorLeaseWriterOptions =
    typeof intervalMsOrOptions === "number"
      ? { intervalMs: intervalMsOrOptions }
      : intervalMsOrOptions;
  const intervalMs = options.intervalMs ?? DEFAULT_LEASE_INTERVAL_MS;
  const orphanAfterMs = options.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS;
  const write = options.write ?? writeSupervisorLease;
  const now = options.now ?? Date.now;
  const logError =
    options.logError ??
    ((message: string) => {
      console.error(message);
    });

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let consecutiveFailures = 0;
  let lastSuccessAt = now();

  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    void write(path)
      .then(() => {
        consecutiveFailures = 0;
        lastSuccessAt = now();
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        const staleMs = now() - lastSuccessAt;
        const detail = error instanceof Error ? error.message : String(error);
        const critical = staleMs >= orphanAfterMs / 2;
        const prefix = critical
          ? "[beacon] supervisor lease refresh failing critically"
          : "[beacon] failed to refresh supervisor lease";
        logError(
          `${prefix}: consecutiveFailures=${consecutiveFailures} staleMs=${staleMs} at=${new Date(now()).toISOString()}: ${detail}`,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
