// TEMP: remove after one-time Mini backfill (delete `beacon migrate-usage` + this module in the next patch after Mini ≥0.7.5 has run migrate successfully once).
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { loadGlobalConfig } from "./config/global.js";
import type { RunUsageRecord, TriggerRecord } from "./domain/types.js";
import { readSessionUsage } from "./runtime/session-usage.js";
import { TriggerStore } from "./state/trigger-store.js";

export type MigrateUsageOptions = {
  configPath: string;
  /** When set, only migrate this Profile id. */
  profileId?: string | undefined;
  /** Report what would change without writing records. */
  dryRun?: boolean | undefined;
  /** Rewrite even when `run.usage` is already present. */
  force?: boolean | undefined;
};

export type MigrateUsageCounters = {
  profiles: number;
  scanned: number;
  written: number;
  skippedExisting: number;
  skippedNoSession: number;
  skippedNoJsonl: number;
  failed: number;
};

function profileIdPattern(): RegExp {
  return /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;
}

function runWindow(run: NonNullable<TriggerRecord["run"]>): {
  since: string;
  until: string | undefined;
} {
  return {
    since: run.startedAt ?? run.queuedAt,
    until: run.finishedAt,
  };
}

async function listProfileIds(profilesDirectory: string): Promise<string[]> {
  const entries = await readdir(profilesDirectory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && profileIdPattern().test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function migrateRecord(options: {
  store: TriggerStore;
  record: TriggerRecord;
  dryRun: boolean;
  force: boolean;
  capturedAt: string;
}): Promise<keyof Omit<MigrateUsageCounters, "profiles" | "scanned">> {
  const run = options.record.run;
  if (!run?.sessionPath) return "skippedNoSession";
  if (run.usage && !options.force) return "skippedExisting";

  const window = runWindow(run);
  const usage = await readSessionUsage({
    sessionPath: run.sessionPath,
    since: window.since,
    until: window.until,
    capturedAt: options.capturedAt,
  });
  if (!usage) return "skippedNoJsonl";

  if (options.dryRun) return "written";

  const nextUsage: RunUsageRecord = usage;
  await options.store.update(options.record.triggerKey, (current) => {
    if (!current.run) return current;
    return {
      ...current,
      run: {
        ...current.run,
        usage: nextUsage,
      },
    };
  });
  return "written";
}

/**
 * One-time backfill: walk Trigger records, extract Pi session usage for each
 * Run's time window, and persist `run.usage`. Safe to re-run; skips records
 * that already have usage unless `force` is set.
 *
 * TEMP: remove after one-time Mini backfill — not a permanent operator CLI.
 */
export async function migrateUsage(
  options: MigrateUsageOptions,
): Promise<MigrateUsageCounters> {
  const global = await loadGlobalConfig(options.configPath);
  const profileIds = options.profileId
    ? [options.profileId]
    : await listProfileIds(global.profilesDirectory);

  if (options.profileId && !profileIdPattern().test(options.profileId)) {
    throw new Error(`Invalid profile id ${JSON.stringify(options.profileId)}`);
  }

  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const capturedAt = new Date().toISOString();
  const counters: MigrateUsageCounters = {
    profiles: 0,
    scanned: 0,
    written: 0,
    skippedExisting: 0,
    skippedNoSession: 0,
    skippedNoJsonl: 0,
    failed: 0,
  };

  for (const profileId of profileIds) {
    const profileDirectory = join(global.profilesDirectory, profileId);
    const store = new TriggerStore(profileDirectory, profileId);
    let records: TriggerRecord[];
    try {
      records = await store.list();
    } catch (error) {
      counters.failed += 1;
      console.error(
        `[beacon] migrate-usage cannot list profile=${profileId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    counters.profiles += 1;

    for (const record of records) {
      counters.scanned += 1;
      try {
        const outcome = await migrateRecord({
          store,
          record,
          dryRun,
          force,
          capturedAt,
        });
        counters[outcome] += 1;
        if (outcome === "written") {
          console.log(
            `[beacon] migrate-usage ${dryRun ? "would write" : "wrote"} profile=${profileId} run=${record.run?.runId ?? "(none)"} trigger=${record.triggerKey.slice(0, 12)}…`,
          );
        }
      } catch (error) {
        counters.failed += 1;
        console.error(
          `[beacon] migrate-usage failed profile=${profileId} trigger=${record.triggerKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  console.log(
    `[beacon] migrate-usage ${dryRun ? "dry-run " : ""}done profiles=${String(counters.profiles)} scanned=${String(counters.scanned)} written=${String(counters.written)} skipped_existing=${String(counters.skippedExisting)} skipped_no_session=${String(counters.skippedNoSession)} skipped_no_jsonl=${String(counters.skippedNoJsonl)} failed=${String(counters.failed)}`,
  );
  return counters;
}

export async function runMigrateUsage(
  configPath: string,
  options: {
    profileId?: string | undefined;
    dryRun?: boolean | undefined;
    force?: boolean | undefined;
  } = {},
): Promise<void> {
  const result = await migrateUsage({
    configPath,
    profileId: options.profileId,
    dryRun: options.dryRun,
    force: options.force,
  });
  if (result.failed > 0) {
    throw new Error(
      `migrate-usage finished with ${String(result.failed)} failure(s)`,
    );
  }
}
