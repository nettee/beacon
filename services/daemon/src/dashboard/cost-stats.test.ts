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
  sessionUsage?: Record<string, unknown> | undefined;
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
  if (options.sessionUsage) {
    await writeFile(
      join(sessionPath, `${options.runId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        timestamp: options.finishedAt,
        message: {
          role: "assistant",
          content: [],
          usage: options.sessionUsage,
        },
      })}\n`,
    );
  }
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

test("buildCostStats aggregates stored usage and JSONL backfill by profile and day", async () => {
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
  const sessionUsage = {
    input: 5,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: {
      input: 0.005,
      output: 0.005,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.01,
    },
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
  await writeRun({
    profiles,
    sessions,
    profileId: "beta",
    triggerKey: "bb",
    runId: "run_jsonl",
    acceptedAt: "2026-10-17T13:00:00.000Z",
    finishedAt: "2026-10-17T14:00:00.000Z",
    sessionUsage,
  });
  // Outside the 1d window.
  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "cc",
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
  assert.equal(day.totals.runCount, 2);
  assert.equal(day.totals.runsWithUsage, 2);
  assert.ok(Math.abs(day.totals.cost.total - 0.04) < 1e-9);
  assert.equal(day.totals.totalTokens, 40);
  assert.equal(day.byProfile.length, 2);
  assert.equal(day.byProfile[0]?.profileId, "alpha");
  assert.equal(day.byProfile[0]?.cost.total, 0.03);
  assert.equal(day.daily.length, 1);
  assert.equal(day.daily[0]?.date, "2026-10-17");

  const filtered = await buildCostStats({
    profilesDirectory: profiles,
    period: "7d",
    profiles: ["beta"],
    now,
  });
  assert.equal(filtered.totals.runCount, 1);
  assert.equal(filtered.byProfile[0]?.profileId, "beta");
  assert.equal(filtered.totals.cost.total, 0.01);
});
