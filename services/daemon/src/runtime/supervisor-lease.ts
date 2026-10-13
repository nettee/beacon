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
  const temporary = `${path}.${process.pid}.tmp`;
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

/** Refresh the lease until stop(). Writes once immediately. */
export function startSupervisorLeaseWriter(
  path: string,
  intervalMs = DEFAULT_LEASE_INTERVAL_MS,
): SupervisorLeaseHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = (): void => {
    void writeSupervisorLease(path).catch((error: unknown) => {
      console.error(
        `[beacon] failed to refresh supervisor lease: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
