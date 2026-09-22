import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const runIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type RunSummary = {
  profileId: string;
  triggerKey: string;
  acceptedAt: string;
  kind: string;
  scheduleId: string | undefined;
  runId: string | undefined;
  state: string | undefined;
  failureCode: string | undefined;
  deliveryState: string | undefined;
  sessionPath: string | undefined;
  hasSessionFile: boolean;
  systemPrompt: string | undefined;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readDirents(path: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

async function sessionHasJsonl(sessionPath: string): Promise<boolean> {
  const entries = await readDirents(sessionPath);
  return (
    entries?.some((entry) => entry.isFile() && entry.name.endsWith(".jsonl")) ??
    false
  );
}

function summarize(
  value: unknown,
  hasSessionFile: boolean,
): RunSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const profileId = asString(record.profileId);
  const triggerKey = asString(record.triggerKey);
  const acceptedAt = asString(record.acceptedAt);
  if (!profileId || !triggerKey || !acceptedAt) return undefined;
  const input = asRecord(record.input);
  const run = asRecord(record.run);
  const delivery = asRecord(record.delivery);
  const failure = asRecord(run?.failure);
  return {
    profileId,
    triggerKey,
    acceptedAt,
    kind: asString(input?.kind) ?? "unknown",
    scheduleId: asString(input?.scheduleId),
    runId: asString(run?.runId),
    state: asString(run?.state),
    failureCode: asString(failure?.code),
    deliveryState: asString(delivery?.state),
    sessionPath: asString(run?.sessionPath),
    hasSessionFile,
    systemPrompt: asString(run?.systemPrompt),
  };
}

async function loadSummary(path: string): Promise<RunSummary | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const sessionPath = asString(asRecord(asRecord(parsed)?.run)?.sessionPath);
    return summarize(
      parsed,
      sessionPath ? await sessionHasJsonl(sessionPath) : false,
    );
  } catch {
    return undefined;
  }
}

export async function listRunSummaries(
  profilesDirectory: string,
): Promise<RunSummary[]> {
  const profiles = await readDirents(profilesDirectory);
  if (!profiles) {
    throw new Error(
      `Cannot read Beacon profiles directory ${profilesDirectory}`,
    );
  }

  const rows: RunSummary[] = [];
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const root = join(profilesDirectory, profile.name, "state", "triggers");
    const entries = await readDirents(root);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summary = await loadSummary(join(root, entry.name, "record.json"));
      if (summary) rows.push(summary);
    }
  }

  rows.sort(
    (left, right) =>
      right.acceptedAt.localeCompare(left.acceptedAt) ||
      (right.runId ?? "").localeCompare(left.runId ?? "") ||
      left.triggerKey.localeCompare(right.triggerKey),
  );
  return rows;
}

export function kindLabel(
  row: Pick<RunSummary, "kind" | "scheduleId">,
): string {
  if (row.kind === "schedule" && row.scheduleId) {
    return `schedule:${row.scheduleId}`;
  }
  return row.kind;
}

export function toRunListItem(row: RunSummary): {
  profileId: string;
  acceptedAt: string;
  kind: string;
  scheduleId: string | null;
  kindLabel: string;
  runId: string | null;
  state: string | null;
  failureCode: string | null;
  deliveryState: string | null;
  hasSessionFile: boolean;
} {
  return {
    profileId: row.profileId,
    acceptedAt: row.acceptedAt,
    kind: row.kind,
    scheduleId: row.scheduleId ?? null,
    kindLabel: kindLabel(row),
    runId: row.runId ?? null,
    state: row.state ?? null,
    failureCode: row.failureCode ?? null,
    deliveryState: row.deliveryState ?? null,
    hasSessionFile: row.hasSessionFile,
  };
}

export async function findRunSummary(
  profilesDirectory: string,
  runId: string,
): Promise<RunSummary | undefined> {
  if (!runIdPattern.test(runId)) return undefined;
  const rows = await listRunSummaries(profilesDirectory);
  return rows.find((row) => row.runId === runId);
}
