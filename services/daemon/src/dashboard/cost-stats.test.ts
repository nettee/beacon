import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCostStats,
  calendarDateInTimezone,
  parseCostModelFilter,
  parseCostPeriod,
} from "./cost-stats.js";

async function writeRun(options: {
  profiles: string;
  sessions: string;
  profileId: string;
  triggerKey: string;
  runId: string;
  acceptedAt: string;
  finishedAt: string;
  provider?: string | undefined;
  model?: string | undefined;
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
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
      },
    }),
  );
}

const sampleUsage = {
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

test("calendarDateInTimezone formats Asia/Shanghai dates", () => {
  // 2026-10-17T16:00Z is already 2026-10-18 in Shanghai.
  assert.equal(
    calendarDateInTimezone("2026-10-17T16:00:00.000Z"),
    "2026-10-18",
  );
});

test("parseCostPeriod only accepts 7d", () => {
  assert.equal(parseCostPeriod("7d"), "7d");
  assert.equal(parseCostPeriod("1d"), undefined);
  assert.equal(parseCostPeriod("30d"), undefined);
});

test("parseCostModelFilter accepts all / model / provider+model", () => {
  assert.deepEqual(parseCostModelFilter({ model: null, provider: null }), {
    ok: true,
    filter: { kind: "all" },
  });
  assert.deepEqual(parseCostModelFilter({ model: "all", provider: null }), {
    ok: true,
    filter: { kind: "all" },
  });
  assert.deepEqual(
    parseCostModelFilter({ model: "gpt-6-luna", provider: null }),
    { ok: true, filter: { kind: "model", model: "gpt-6-luna" } },
  );
  assert.deepEqual(
    parseCostModelFilter({
      model: "gpt-6-luna",
      provider: "openai-codex",
    }),
    {
      ok: true,
      filter: {
        kind: "model",
        model: "gpt-6-luna",
        provider: "openai-codex",
      },
    },
  );
  assert.equal(
    parseCostModelFilter({ model: null, provider: "openai-codex" }).ok,
    false,
  );
  assert.equal(
    parseCostModelFilter({ model: "all", provider: "openai-codex" }).ok,
    false,
  );
});

test("buildCostStats aggregates only stored run.usage (no live JSONL backfill)", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-cost-"));
  const profiles = join(root, "profiles");
  const sessions = join(root, "sessions");
  const now = new Date("2026-10-18T03:00:00.000Z");

  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "aa",
    runId: "run_stored",
    acceptedAt: "2026-10-17T11:00:00.000Z",
    finishedAt: "2026-10-17T12:00:00.000Z",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: sampleUsage,
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
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
  });
  // Mid-week run still inside fixed 7d window.
  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "cc",
    runId: "run_week",
    acceptedAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T01:00:00.000Z",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: sampleUsage,
  });
  // Outside the 7d window.
  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "dd",
    runId: "run_old",
    acceptedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T01:00:00.000Z",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: sampleUsage,
  });

  const week = await buildCostStats({
    profilesDirectory: profiles,
    now,
  });
  assert.equal(week.period, "7d");
  assert.equal(week.totals.runCount, 3);
  assert.equal(week.totals.runsWithUsage, 2);
  assert.equal(week.totals.runsMissingUsage, 1);
  assert.ok(Math.abs(week.totals.cost.total - 0.06) < 1e-9);
  assert.equal(week.totals.totalTokens, 60);
  assert.equal(week.byProfile.length, 2);
  assert.equal(week.byProfile[0]?.profileId, "alpha");
  assert.equal(week.byProfile[0]?.cost.total, 0.06);
  assert.equal(week.byProfile[1]?.profileId, "beta");
  assert.equal(week.byProfile[1]?.runsMissingUsage, 1);
  assert.equal(week.daily.length, 2);
  assert.equal(week.daily[0]?.date, "2026-10-14");
  assert.equal(week.daily[1]?.date, "2026-10-17");
  assert.ok(Math.abs((week.daily[0]?.cost.total ?? 0) - 0.03) < 1e-9);
  assert.ok(Math.abs((week.daily[1]?.cost.total ?? 0) - 0.03) < 1e-9);
  assert.equal(week.dailyByProfile.length, 3);
  assert.equal(week.chartFrom, week.from);
  assert.equal(week.chartTo, week.to);
  assert.equal(week.from, "2026-10-11T03:00:00.000Z");
  assert.equal(week.to, "2026-10-18T03:00:00.000Z");
  assert.deepEqual(week.modelFilter, { kind: "all" });
  assert.deepEqual(week.models, [
    { provider: "openai-codex", model: "gpt-6-luna" },
    { provider: "opencode-go", model: "deepseek-v4.1-flash" },
  ]);

  const filtered = await buildCostStats({
    profilesDirectory: profiles,
    profiles: ["beta"],
    now,
  });
  assert.equal(filtered.totals.runCount, 1);
  assert.equal(filtered.totals.runsMissingUsage, 1);
  assert.equal(filtered.totals.cost.total, 0);
  assert.equal(filtered.dailyByProfile.length, 1);
  assert.equal(filtered.dailyByProfile[0]?.profileId, "beta");
  assert.deepEqual(filtered.models, [
    { provider: "opencode-go", model: "deepseek-v4.1-flash" },
  ]);
});

test("buildCostStats filters by model and provider+model", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-cost-model-"));
  const profiles = join(root, "profiles");
  const sessions = join(root, "sessions");
  const now = new Date("2026-10-18T03:00:00.000Z");

  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "luna",
    runId: "run_luna",
    acceptedAt: "2026-10-17T11:00:00.000Z",
    finishedAt: "2026-10-17T12:00:00.000Z",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: sampleUsage,
  });
  await writeRun({
    profiles,
    sessions,
    profileId: "alpha",
    triggerKey: "flash",
    runId: "run_flash",
    acceptedAt: "2026-10-17T13:00:00.000Z",
    finishedAt: "2026-10-17T14:00:00.000Z",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    usage: {
      ...sampleUsage,
      totalTokens: 40,
      cost: { ...sampleUsage.cost, total: 0.04 },
    },
  });

  const byModel = await buildCostStats({
    profilesDirectory: profiles,
    modelFilter: { kind: "model", model: "gpt-6-luna" },
    now,
  });
  assert.equal(byModel.totals.runCount, 1);
  assert.ok(Math.abs(byModel.totals.cost.total - 0.03) < 1e-9);
  assert.deepEqual(byModel.modelFilter, {
    kind: "model",
    model: "gpt-6-luna",
  });
  // Dropdown still lists every model in the window.
  assert.equal(byModel.models.length, 2);

  const byPair = await buildCostStats({
    profilesDirectory: profiles,
    modelFilter: {
      kind: "model",
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
    },
    now,
  });
  assert.equal(byPair.totals.runCount, 1);
  assert.ok(Math.abs(byPair.totals.cost.total - 0.04) < 1e-9);

  // Unknown model → empty aggregates (not a wrong window).
  const unknown = await buildCostStats({
    profilesDirectory: profiles,
    modelFilter: { kind: "model", model: "does-not-exist" },
    now,
  });
  assert.equal(unknown.totals.runCount, 0);
  assert.equal(unknown.totals.cost.total, 0);
  assert.equal(unknown.daily.length, 0);
  assert.equal(unknown.models.length, 2);
  assert.equal(unknown.from, "2026-10-11T03:00:00.000Z");
});
