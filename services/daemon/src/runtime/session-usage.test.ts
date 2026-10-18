import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseUsageBlob,
  readSessionUsage,
  sumUsageFromJsonl,
} from "./session-usage.js";

const usageA = {
  input: 10,
  output: 20,
  cacheRead: 100,
  cacheWrite: 5,
  totalTokens: 135,
  cost: {
    input: 0.01,
    output: 0.02,
    cacheRead: 0.001,
    cacheWrite: 0.003,
    total: 0.034,
  },
};

const usageB = {
  input: 3,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 7,
  cost: {
    input: 0.001,
    output: 0.002,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.003,
  },
};

test("parseUsageBlob fills optional cache fields", () => {
  assert.deepEqual(
    parseUsageBlob({
      input: 1,
      output: 2,
      cost: { total: 0.5 },
    }),
    {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.5,
      },
    },
  );
});

test("sumUsageFromJsonl aggregates assistant, usage, and compaction entries", () => {
  const jsonl = [
    JSON.stringify({ type: "session", id: "s1" }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-10-17T10:00:00.000Z",
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-10-17T10:01:00.000Z",
      message: { role: "assistant", content: [], usage: usageA },
    }),
    JSON.stringify({
      type: "usage",
      timestamp: "2026-10-17T10:02:00.000Z",
      kind: "cache_warm",
      usage: usageB,
    }),
    JSON.stringify({
      type: "compaction",
      timestamp: "2026-10-17T10:03:00.000Z",
      usage: usageB,
    }),
  ].join("\n");

  const totals = sumUsageFromJsonl(jsonl);
  assert.equal(totals.input, 16);
  assert.equal(totals.output, 28);
  assert.equal(totals.cacheRead, 100);
  assert.equal(totals.cacheWrite, 5);
  assert.equal(totals.totalTokens, 149);
  assert.ok(Math.abs(totals.cost.total - 0.04) < 1e-9);
});

test("sumUsageFromJsonl respects since/until for continued sessions", () => {
  const jsonl = [
    JSON.stringify({
      type: "message",
      timestamp: "2026-10-17T09:00:00.000Z",
      message: { role: "assistant", content: [], usage: usageA },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-10-17T11:00:00.000Z",
      message: { role: "assistant", content: [], usage: usageB },
    }),
  ].join("\n");

  const totals = sumUsageFromJsonl(jsonl, {
    since: "2026-10-17T10:00:00.000Z",
    until: "2026-10-17T12:00:00.000Z",
  });
  assert.deepEqual(totals.input, usageB.input);
  assert.deepEqual(totals.cost.total, usageB.cost.total);
});

test("readSessionUsage loads the latest jsonl in a session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-usage-"));
  const sessionPath = join(root, "alpha", "run_1");
  await mkdir(sessionPath, { recursive: true });
  await writeFile(
    join(sessionPath, "2026-10-17T10-00-00Z_run_1.jsonl"),
    `${JSON.stringify({
      type: "message",
      timestamp: "2026-10-17T10:01:00.000Z",
      message: { role: "assistant", content: [], usage: usageA },
    })}\n`,
  );
  const usage = await readSessionUsage({
    sessionPath,
    since: "2026-10-17T10:00:00.000Z",
    until: "2026-10-17T11:00:00.000Z",
    capturedAt: "2026-10-17T11:00:00.000Z",
  });
  assert.ok(usage);
  assert.equal(usage.source, "pi_session");
  assert.equal(usage.input, usageA.input);
  assert.equal(usage.cost.total, usageA.cost.total);
});
