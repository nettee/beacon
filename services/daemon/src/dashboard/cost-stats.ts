import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  addUsageTotals,
  emptyUsageTotals,
  parseUsageBlob,
  type UsageTotals,
} from "../runtime/session-usage.js";

export type CostPeriod = "1d" | "7d";

export type CostBucket = UsageTotals & {
  runCount: number;
  runsWithUsage: number;
  runsMissingUsage: number;
};

export type CostStatsProfileBucket = CostBucket & { profileId: string };

export type CostStatsDailyBucket = CostBucket & { date: string };

export type CostStatsResponse = {
  period: CostPeriod;
  timezone: string;
  from: string;
  to: string;
  totals: CostBucket;
  byProfile: CostStatsProfileBucket[];
  daily: CostStatsDailyBucket[];
};

const TIMEZONE = "Asia/Shanghai";

type RunCostRow = {
  profileId: string;
  runId: string | undefined;
  acceptedAt: string;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  sessionPath: string | undefined;
  usage: UsageTotals | undefined;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emptyBucket(): CostBucket {
  return {
    ...emptyUsageTotals(),
    runCount: 0,
    runsWithUsage: 0,
    runsMissingUsage: 0,
  };
}

function addBucket(left: CostBucket, right: CostBucket): CostBucket {
  const totals = addUsageTotals(left, right);
  return {
    ...totals,
    runCount: left.runCount + right.runCount,
    runsWithUsage: left.runsWithUsage + right.runsWithUsage,
    runsMissingUsage: left.runsMissingUsage + right.runsMissingUsage,
  };
}

function parseStoredUsage(value: unknown): UsageTotals | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return parseUsageBlob(record);
}

async function readDirents(path: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

function runAnchorTime(row: RunCostRow): string {
  return row.finishedAt ?? row.startedAt ?? row.acceptedAt;
}

/** Calendar date `YYYY-MM-DD` in the Dashboard timezone. */
export function calendarDateInTimezone(
  iso: string,
  timeZone: string = TIMEZONE,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function periodWindow(
  period: CostPeriod,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = now.toISOString();
  const ms = period === "1d" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const from = new Date(now.getTime() - ms).toISOString();
  return { from, to };
}

async function loadRunCostRow(path: string): Promise<RunCostRow | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const record = asRecord(parsed);
    if (!record) return undefined;
    const profileId = asString(record.profileId);
    const acceptedAt = asString(record.acceptedAt);
    if (!profileId || !acceptedAt) return undefined;
    const run = asRecord(record.run);
    return {
      profileId,
      runId: asString(run?.runId),
      acceptedAt,
      startedAt: asString(run?.startedAt),
      finishedAt: asString(run?.finishedAt),
      sessionPath: asString(run?.sessionPath),
      usage: parseStoredUsage(run?.usage),
    };
  } catch {
    return undefined;
  }
}

export async function listRunCostRows(
  profilesDirectory: string,
): Promise<RunCostRow[]> {
  const profiles = await readDirents(profilesDirectory);
  if (!profiles) {
    throw new Error(
      `Cannot read Beacon profiles directory ${profilesDirectory}`,
    );
  }
  const rows: RunCostRow[] = [];
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const root = join(profilesDirectory, profile.name, "state", "triggers");
    const entries = await readDirents(root);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || /^\.claim-[0-9a-f-]{36}$/.test(entry.name)) {
        continue;
      }
      const row = await loadRunCostRow(join(root, entry.name, "record.json"));
      if (row) rows.push(row);
    }
  }
  return rows;
}

export async function buildCostStats(options: {
  profilesDirectory: string;
  period: CostPeriod;
  profiles?: string[] | undefined;
  now?: Date | undefined;
}): Promise<CostStatsResponse> {
  const now = options.now ?? new Date();
  const { from, to } = periodWindow(options.period, now);
  const profileFilter =
    options.profiles && options.profiles.length > 0
      ? new Set(options.profiles)
      : undefined;

  const rows = (await listRunCostRows(options.profilesDirectory)).filter(
    (row) => {
      if (profileFilter && !profileFilter.has(row.profileId)) return false;
      // Only terminal-ish runs with a time anchor inside the window.
      const anchor = runAnchorTime(row);
      return anchor >= from && anchor <= to;
    },
  );

  let totals = emptyBucket();
  const byProfile = new Map<string, CostBucket>();
  const daily = new Map<string, CostBucket>();

  for (const row of rows) {
    // Durable `run.usage` only — no on-request JSONL re-read (see migrate-usage).
    const missing = row.usage === undefined;
    const piece: CostBucket = {
      ...(row.usage ?? emptyUsageTotals()),
      runCount: 1,
      runsWithUsage: missing ? 0 : 1,
      runsMissingUsage: missing ? 1 : 0,
    };
    totals = addBucket(totals, piece);
    byProfile.set(
      row.profileId,
      addBucket(byProfile.get(row.profileId) ?? emptyBucket(), piece),
    );
    const date = calendarDateInTimezone(runAnchorTime(row));
    daily.set(date, addBucket(daily.get(date) ?? emptyBucket(), piece));
  }

  return {
    period: options.period,
    timezone: TIMEZONE,
    from,
    to,
    totals,
    byProfile: [...byProfile.entries()]
      .map(([profileId, bucket]) => ({ profileId, ...bucket }))
      .sort(
        (left, right) =>
          right.cost.total - left.cost.total ||
          left.profileId.localeCompare(right.profileId),
      ),
    daily: [...daily.entries()]
      .map(([date, bucket]) => ({ date, ...bucket }))
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export function parseCostPeriod(value: string | null): CostPeriod | undefined {
  if (value === "1d" || value === "7d") return value;
  return undefined;
}
