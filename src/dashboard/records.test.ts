import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listRunSummaries } from "./records.js";

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
      },
    ],
  );
});
