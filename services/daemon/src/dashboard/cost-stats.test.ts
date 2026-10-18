import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCostStats, calendarDateInTimezone } from "./cost-stats.js";

async function writeRun(options: {
  profiles: string;
  sessions: string;
  profileId: string;
  triggerKey: string;
  runId: string;
  acceptedAt: string;
  finishedAt: string;
  usage?: Record<string, unknown> | undefined;
}): Promise<void> {
  const sessionPath = join(options.sessions, options.profileId, options.runId);
  await mkdir(sessionPath, { recursive: true });
  await mkdir(
    join(
      options.profiles,
      options.profileId,
      "state",
      "triggers",
      options.triggerKey,
    ),
    { recursive: true },
  );
  await writeFile(
    join(
      options.profiles,
      options.profileId,
      "state",
      "triggers",
      options.triggerKey,
      "record.json",
    ),
    JSON.stringify({
      triggerKey: options.triggerKey,
      profileId: options.profileId,
      acceptedAt: options.acceptedAt,
      input: { kind: "manual" },
      run: {
        runId: options.runId,
        state: "succeeded",
        queuedAt: options.acceptedAt,
        startedAt: options.acceptedAt,
        finishedAt: options.finishedAt,
        sessionPath,
        ...(options.usage ? { usage: options.usage } : {}),
      },
    }),
  );
}

test("calendarDateInTimezone formats Asia/Shanghai dates", () => {
  // 2026-10-17T16:00Z is already 2026-10-18 in Shanghai.
  assert.equal(
    calendarDateInTimezone("2026-10-17T16:00:00.000Z"),
    "2026-10-18",
  );
});

test("buildCostStats aggregates only stored run.usage (no live JSONL backfill)", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-cost-"));
  const profiles = join(root, "profiles");
  const sessions = join(root, "sessions");
  const now = new Date("2026-10-18T03:00:00.000Z");

  const storedUsage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.03,
    },
    source: "pi_session",
    capturedAt: "2026-10-17T12:00:00.000Z",
  };

  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "aa",
    runId: "run_stored",
    acceptedAt: "2026-10-17T11:00:00.000Z",
    finishedAt: "2026-10-17T12:00:00.000Z",
    usage: storedUsage,
  });
  // Has a session path but no durable usage — must count as missing, not scan JSONL.
  await writeRun({
    profiles,
    sessions,
    profileId: "beta",
    triggerKey: "bb",
    runId: "run_missing",
    acceptedAt: "2026-10-17T13:00:00.000Z",
    finishedAt: "2026-10-17T14:00:00.000Z",
  });
  // Inside 7d chart window but outside the 1d summary window.
  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "cc",
    runId: "run_week",
    acceptedAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T01:00:00.000Z",
    usage: storedUsage,
  });
  // Outside the 7d chart window.
  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "dd",
    runId: "run_old",
    acceptedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T01:00:00.000Z",
    usage: storedUsage,
  });

  const day = await buildCostStats({
    profilesDirectory: profiles,
    period: "1d",
    now,
  });
  // Summary follows period=1d (only the two recent runs).
  assert.equal(day.totals.runCount, 2);
  assert.equal(day.totals.runsWithUsage, 1);
  assert.equal(day.totals.runsMissingUsage, 1);
  assert.ok(Math.abs(day.totals.cost.total - 0.03) < 1e-9);
  assert.equal(day.totals.totalTokens, 30);
  assert.equal(day.byProfile.length, 2);
  assert.equal(day.byProfile[0]?.profileId, "alpha");
  assert.equal(day.byProfile[0]?.cost.total, 0.03);
  assert.equal(day.byProfile[1]?.profileId, "beta");
  assert.equal(day.byProfile[1]?.runsMissingUsage, 1);
  // Charts stay fixed at 7d — include the mid-week run as well.
  assert.equal(day.daily.length, 2);
  assert.equal(day.daily[0]?.date, "2026-10-14");
  assert.equal(day.daily[1]?.date, "2026-10-17");
  assert.ok(Math.abs((day.daily[0]?.cost.total ?? 0) - 0.03) < 1e-9);
  assert.ok(Math.abs((day.daily[1]?.cost.total ?? 0) - 0.03) < 1e-9);
  assert.equal(day.dailyByProfile.length, 3);
  assert.equal(day.chartFrom, "2026-10-11T03:00:00.000Z");
  assert.equal(day.chartTo, "2026-10-18T03:00:00.000Z");
  assert.equal(day.from, "2026-10-17T03:00:00.000Z");
  assert.equal(day.to, "2026-10-18T03:00:00.000Z");

  const filtered = await buildCostStats({
    profilesDirectory: profiles,
    period: "7d",
    profiles: ["beta"],
    now,
  });
  assert.equal(filtered.totals.runCount, 1);
  assert.equal(filtered.totals.runsMissingUsage, 1);
  assert.equal(filtered.totals.cost.total, 0);
  assert.equal(filtered.dailyByProfile.length, 1);
  assert.equal(filtered.dailyByProfile[0]?.profileId, "beta");
});
