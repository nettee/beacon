import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listRunSummaries, toRunListItem } from "./records.js";

async function fixture(): Promise<{ profiles: string; sessions: string }> {
  const root = await mkdtemp(join(tmpdir(), "beacon-dashboard-"));
  const profiles = join(root, "profiles");
  const sessions = join(root, "sessions");
  await mkdir(join(profiles, "alpha", "state", "triggers", "aa"), {
    recursive: true,
  });
  await mkdir(join(profiles, "beta", "state", "triggers", "bb"), {
    recursive: true,
  });
  await mkdir(join(sessions, "alpha", "run_ok"), { recursive: true });
  await writeFile(
    join(sessions, "alpha", "run_ok", "2026-01-01T00-00-00Z_run_ok.jsonl"),
    '{"type":"session","id":"run_ok"}\n',
  );
  await writeFile(
    join(profiles, "alpha", "state", "triggers", "aa", "record.json"),
    JSON.stringify({
      triggerKey: "aa",
      profileId: "alpha",
      acceptedAt: "2026-01-02T00:00:00.000Z",
      input: { kind: "schedule", scheduleId: "hourly" },
      run: {
        runId: "run_ok",
        state: "failed",
        failure: { code: "runtime_timeout" },
        sessionPath: join(sessions, "alpha", "run_ok"),
      },
    }),
  );
  await writeFile(
    join(profiles, "beta", "state", "triggers", "bb", "record.json"),
    JSON.stringify({
      triggerKey: "bb",
      profileId: "beta",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      input: { kind: "feishu_message" },
      run: { runId: "run_gone", state: "succeeded" },
    }),
  );
  return { profiles, sessions };
}

test("lists runs newest first and notes missing session files", async () => {
  const { profiles } = await fixture();
  const rows = await listRunSummaries(profiles);
  assert.deepEqual(
    rows.map((row) => ({
      runId: row.runId,
      kind: row.kind,
      scheduleId: row.scheduleId,
      hasNotifyTarget: row.hasNotifyTarget,
      state: row.state,
      failureCode: row.failureCode,
      hasSessionFile: row.hasSessionFile,
      systemPrompt: row.systemPrompt,
      feedback: row.feedback,
    })),
    [
      {
        runId: "run_ok",
        kind: "schedule",
        scheduleId: "hourly",
        hasNotifyTarget: false,
        state: "failed",
        failureCode: "runtime_timeout",
        hasSessionFile: true,
        systemPrompt: undefined,
        feedback: undefined,
      },
      {
        runId: "run_gone",
        kind: "feishu_message",
        scheduleId: undefined,
        hasNotifyTarget: false,
        state: "succeeded",
        failureCode: undefined,
        hasSessionFile: false,
        systemPrompt: undefined,
        feedback: undefined,
      },
    ],
  );
});

test("exposes feedback items on the list payload only when present", async () => {
  const { profiles } = await fixture();
  const rows = await listRunSummaries(profiles);
  assert.equal(toRunListItem(rows[0]!).feedback, null);
  const withItems = {
    ...rows[0]!,
    feedback: {
      items: [
        {
          priority: "high" as const,
          summary: "GRAFANA_READER_TOKEN_PROD is unset.",
        },
      ],
      submittedAt: "2026-01-02T00:01:00.000Z",
    },
  };
  assert.deepEqual(toRunListItem(withItems).feedback, [
    {
      priority: "high",
      summary: "GRAFANA_READER_TOKEN_PROD is unset.",
    },
  ]);
});

test("labels event Runs with their event type and source", async () => {
  const { profiles } = await fixture();
  await writeFile(
    join(profiles, "alpha", "state", "triggers", "aa", "record.json"),
    JSON.stringify({
      triggerKey: "aa",
      profileId: "alpha",
      acceptedAt: "2026-01-02T00:00:00.000Z",
      input: {
        kind: "event",
        event: {
          specversion: "1.0",
          id: "e",
          source: "https://deploy.example.com",
          type: "deployment.completed",
        },
      },
      run: { runId: "run_event", state: "succeeded" },
    }),
  );
  const [row] = await listRunSummaries(profiles);
  assert.equal(row?.kind, "event");
  assert.equal(row?.eventSource, "https://deploy.example.com");
  assert.equal(
    toRunListItem(row!).kindLabel,
    "event:deployment.completed (https://deploy.example.com)",
  );
});

test("excludes complete but unpublished temporary claims from dashboard rows", async () => {
  const { profiles } = await fixture();
  const temporary = join(
    profiles,
    "alpha",
    "state",
    "triggers",
    ".claim-12345678-1234-1234-1234-123456789abc",
  );
  await mkdir(temporary);
  await writeFile(
    join(temporary, "record.json"),
    JSON.stringify({
      triggerKey: "unpublished",
      profileId: "alpha",
      acceptedAt: "2026-01-03T00:00:00.000Z",
      input: {
        kind: "event",
        event: {
          specversion: "1.0",
          id: "e",
          source: "https://example.com",
          type: "example.event",
        },
      },
      run: { runId: "run_unpublished", state: "queued" },
    }),
  );
  const rows = await listRunSummaries(profiles);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.some((row) => row.triggerKey === "unpublished"),
    false,
  );
});
