import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Pi-attributed usage totals (USD cost from Pi session metadata). */
export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type RunUsage = UsageTotals & {
  source: "pi_session";
  capturedAt: string;
};

export function emptyUsageTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsageTotals(
  left: UsageTotals,
  right: UsageTotals,
): UsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Parse one Pi `usage` object; returns undefined when required fields are missing. */
export function parseUsageBlob(value: unknown): UsageTotals | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = asNumber(record.input);
  const output = asNumber(record.output);
  const cacheRead = asNumber(record.cacheRead) ?? 0;
  const cacheWrite = asNumber(record.cacheWrite) ?? 0;
  if (input === undefined || output === undefined) return undefined;
  const costRecord = asRecord(record.cost);
  const costInput = asNumber(costRecord?.input) ?? 0;
  const costOutput = asNumber(costRecord?.output) ?? 0;
  const costCacheRead = asNumber(costRecord?.cacheRead) ?? 0;
  const costCacheWrite = asNumber(costRecord?.cacheWrite) ?? 0;
  const costTotal =
    asNumber(costRecord?.total) ??
    costInput + costOutput + costCacheRead + costCacheWrite;
  const totalTokens =
    asNumber(record.totalTokens) ?? input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

function entryTimestamp(entry: Record<string, unknown>): string | undefined {
  return typeof entry.timestamp === "string" && entry.timestamp.length > 0
    ? entry.timestamp
    : undefined;
}

function inWindow(
  timestamp: string | undefined,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (!timestamp) return since === undefined && until === undefined;
  if (since !== undefined && timestamp < since) return false;
  if (until !== undefined && timestamp > until) return false;
  return true;
}

function usageFromEntry(
  entry: Record<string, unknown>,
): UsageTotals | undefined {
  if (entry.type === "usage") {
    return parseUsageBlob(entry.usage);
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return parseUsageBlob(entry.usage);
  }
  if (entry.type === "message") {
    const message = asRecord(entry.message);
    if (message?.role === "assistant") {
      return parseUsageBlob(message.usage);
    }
  }
  return undefined;
}

/**
 * Sum Pi-attributed usage from a session JSONL string.
 * Optional `since`/`until` (ISO) attribute a continued session to one Run.
 */
export function sumUsageFromJsonl(
  source: string,
  options: { since?: string | undefined; until?: string | undefined } = {},
): UsageTotals {
  let totals = emptyUsageTotals();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    if (!entry) continue;
    if (!inWindow(entryTimestamp(entry), options.since, options.until)) {
      continue;
    }
    const usage = usageFromEntry(entry);
    if (usage) totals = addUsageTotals(totals, usage);
  }
  return totals;
}

/** Latest `*.jsonl` in a per-Run (or continued) session directory. */
export async function findSessionJsonl(
  sessionPath: string,
): Promise<string | undefined> {
  try {
    const entries = await readdir(sessionPath, { withFileTypes: true });
    const jsonl = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(sessionPath, entry.name))
      .sort();
    return jsonl.at(-1);
  } catch {
    return undefined;
  }
}

export async function readSessionUsage(options: {
  sessionPath: string;
  since?: string | undefined;
  until?: string | undefined;
  capturedAt?: string | undefined;
}): Promise<RunUsage | undefined> {
  const jsonlPath = await findSessionJsonl(options.sessionPath);
  if (!jsonlPath) return undefined;
  try {
    const source = await readFile(jsonlPath, "utf8");
    const totals = sumUsageFromJsonl(source, {
      since: options.since,
      until: options.until,
    });
    // Empty session (no assistant turns yet) still counts as captured zeros.
    return {
      ...totals,
      source: "pi_session",
      capturedAt: options.capturedAt ?? new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}
