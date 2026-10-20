import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  addUsageTotals,
  emptyUsageTotals,
  parseUsageBlob,
  type UsageTotals,
} from "../runtime/session-usage.js";

/** Cost stats window is fixed at 7 days (summary + charts). */
export type CostPeriod = "7d";

export type CostModelRef = {
  provider: string;
  model: string;
};

export type CostModelFilter =
  | { kind: "all" }
  | { kind: "model"; model: string; provider?: string };

export type CostBucket = UsageTotals & {
  runCount: number;
  runsWithUsage: number;
  runsMissingUsage: number;
};

export type CostStatsProfileBucket = CostBucket & { profileId: string };

export type CostStatsDailyBucket = CostBucket & { date: string };

export type CostStatsDailyProfileBucket = CostBucket & {
  date: string;
  profileId: string;
};

export type CostStatsResponse = {
  period: CostPeriod;
  timezone: string;
  from: string;
  to: string;
  /** Echo of the applied model filter (`all` or provider/model). */
  modelFilter: CostModelFilter;
  /** Distinct provider/model pairs seen in the 7d window (profile-filtered). */
  models: CostModelRef[];
  totals: CostBucket;
  byProfile: CostStatsProfileBucket[];
  /** Same window as `from`/`to` (kept for older clients). */
  chartFrom: string;
  chartTo: string;
  daily: CostStatsDailyBucket[];
  /** Per calendar day × profile cost buckets (for stacked shares / per-profile daily charts). */
  dailyByProfile: CostStatsDailyProfileBucket[];
};

const TIMEZONE = "Asia/Shanghai";
const PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

type RunCostRow = {
  profileId: string;
  runId: string | undefined;
  acceptedAt: string;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  sessionPath: string | undefined;
  provider: string | undefined;
  model: string | undefined;
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

export function periodWindow(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const to = now.toISOString();
  const from = new Date(now.getTime() - PERIOD_MS).toISOString();
  return { from, to };
}

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function matchesModelFilter(row: RunCostRow, filter: CostModelFilter): boolean {
  if (filter.kind === "all") return true;
  if (!row.model) return false;
  if (row.model !== filter.model) return false;
  if (filter.provider !== undefined && row.provider !== filter.provider) {
    return false;
  }
  return true;
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
      provider: asString(run?.provider),
      model: asString(run?.model),
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
  period?: CostPeriod | undefined;
  profiles?: string[] | undefined;
  modelFilter?: CostModelFilter | undefined;
  now?: Date | undefined;
}): Promise<CostStatsResponse> {
  const now = options.now ?? new Date();
  const window = periodWindow(now);
  const modelFilter = options.modelFilter ?? { kind: "all" };
  const profileFilter =
    options.profiles && options.profiles.length > 0
      ? new Set(options.profiles)
      : undefined;

  const inWindow = (await listRunCostRows(options.profilesDirectory)).filter(
    (row) => {
      if (profileFilter && !profileFilter.has(row.profileId)) return false;
      const anchor = runAnchorTime(row);
      return anchor >= window.from && anchor <= window.to;
    },
  );

  const modelsByKey = new Map<string, CostModelRef>();
  for (const row of inWindow) {
    if (!row.provider || !row.model) continue;
    const key = modelKey(row.provider, row.model);
    if (!modelsByKey.has(key)) {
      modelsByKey.set(key, { provider: row.provider, model: row.model });
    }
  }
  const models = [...modelsByKey.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model),
  );

  const rows = inWindow.filter((row) => matchesModelFilter(row, modelFilter));

  let totals = emptyBucket();
  const byProfile = new Map<string, CostBucket>();
  const daily = new Map<string, CostBucket>();
  const dailyByProfile = new Map<string, CostBucket>();

  for (const row of rows) {
    // Durable `run.usage` only — no on-request JSONL re-read.
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
    const dayProfileKey = `${date}\0${row.profileId}`;
    dailyByProfile.set(
      dayProfileKey,
      addBucket(dailyByProfile.get(dayProfileKey) ?? emptyBucket(), piece),
    );
  }

  return {
    period: "7d",
    timezone: TIMEZONE,
    from: window.from,
    to: window.to,
    modelFilter,
    models,
    totals,
    byProfile: [...byProfile.entries()]
      .map(([profileId, bucket]) => ({ profileId, ...bucket }))
      .sort(
        (left, right) =>
          right.cost.total - left.cost.total ||
          left.profileId.localeCompare(right.profileId),
      ),
    chartFrom: window.from,
    chartTo: window.to,
    daily: [...daily.entries()]
      .map(([date, bucket]) => ({ date, ...bucket }))
      .sort((left, right) => left.date.localeCompare(right.date)),
    dailyByProfile: [...dailyByProfile.entries()]
      .map(([key, bucket]) => {
        const [date, profileId] = key.split("\0") as [string, string];
        return { date, profileId, ...bucket };
      })
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.profileId.localeCompare(right.profileId),
      ),
  };
}

export function parseCostPeriod(value: string | null): CostPeriod | undefined {
  // Omitted / empty defaults to 7d at the call site; only "7d" is accepted.
  if (value === "7d") return value;
  return undefined;
}

/**
 * Parse model filter query params.
 * - omit / `model=all` → all models
 * - `model=<id>` → filter by model id
 * - `provider=<p>&model=<id>` → filter by both
 * - `provider` without `model` → error
 */
export function parseCostModelFilter(params: {
  model: string | null;
  provider: string | null;
}): { ok: true; filter: CostModelFilter } | { ok: false; error: string } {
  const modelRaw = params.model?.trim() ?? "";
  const providerRaw = params.provider?.trim() ?? "";

  if (providerRaw && !modelRaw) {
    return {
      ok: false,
      error: "provider requires model (use model=all for every model)",
    };
  }

  if (!modelRaw || modelRaw === "all") {
    if (providerRaw) {
      return {
        ok: false,
        error: "provider cannot be set when model is all",
      };
    }
    return { ok: true, filter: { kind: "all" } };
  }

  return {
    ok: true,
    filter: providerRaw
      ? { kind: "model", model: modelRaw, provider: providerRaw }
      : { kind: "model", model: modelRaw },
  };
}
