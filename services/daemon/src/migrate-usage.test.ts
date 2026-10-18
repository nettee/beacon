import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateUsage } from "./migrate-usage.js";
import { TriggerStore } from "./state/trigger-store.js";

async function fixture(): Promise<{
  root: string;
  configPath: string;
  profiles: string;
  sessions: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "beacon-migrate-usage-"));
  const profiles = join(root, "profiles");
  const sessions = join(root, "sessions");
  const piHome = join(root, "pi-home");
  const pi = join(root, "pi");
  await mkdir(profiles);
  await mkdir(sessions);
  await mkdir(piHome);
  await writeFile(pi, "#!/bin/sh\n", { mode: 0o700 });
  await chmod(pi, 0o700);
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    [
      "version: 1",
      "profiles_directory: profiles",
      "pi:",
      `  executable: ${pi}`,
      `  coding_agent_directory: ${piHome}`,
      `  session_directory: ${sessions}`,
      "runs:",
      "  max_concurrent: 2",
      "  max_queued: 10",
      "  timeout_seconds: 60",
      "  terminate_grace_seconds: 5",
      "scheduler:",
      "  max_occurrences_per_reconciliation: 10",
      "",
    ].join("\n"),
  );
  return { root, configPath, profiles, sessions };
}

test("migrate-usage writes run.usage from session JSONL and is idempotent", async () => {
  const { configPath, profiles, sessions } = await fixture();
  const profileDirectory = join(profiles, "alpha");
  await mkdir(profileDirectory, { recursive: true });
  const store = new TriggerStore(profileDirectory, "alpha");
  const claimed = await store.claim({
    sourceKey: ["manual", "migrate-1"],
    target: { kind: "local_stdout" },
  });
  const sessionPath = join(sessions, "alpha", "run_migrate");
  await mkdir(sessionPath, { recursive: true });
  const startedAt = "2026-10-17T12:00:00.000Z";
  const finishedAt = "2026-10-17T12:05:00.000Z";
  await writeFile(
    join(sessionPath, "run_migrate.jsonl"),
    `${JSON.stringify({
      type: "message",
      timestamp: "2026-10-17T12:01:00.000Z",
      message: {
        role: "assistant",
        content: [],
        usage: {
          input: 7,
          output: 9,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 16,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.003,
          },
        },
      },
    })}\n`,
  );
  await store.update(claimed.record.triggerKey, (record) => ({
    ...record,
    run: {
      runId: "run_migrate",
      sessionId: "run_migrate",
      sessionPath,
      state: "succeeded",
      queuedAt: startedAt,
      startedAt,
      finishedAt,
      provider: "test",
      model: "fake",
      playbook: "/tmp/playbook",
      promptDigest: "a".repeat(64),
    },
    finalOutcome: {
      origin: "agent",
      content: { reply: { kind: "text", text: "ok" } },
      submittedAt: finishedAt,
    },
  }));

  const first = await migrateUsage({ configPath });
  assert.equal(first.written, 1);
  assert.equal(first.skippedExisting, 0);

  const raw = JSON.parse(
    await readFile(store.recordPath(claimed.record.triggerKey), "utf8"),
  ) as { run: { usage: { input: number; cost: { total: number } } } };
  assert.equal(raw.run.usage.input, 7);
  assert.equal(raw.run.usage.cost.total, 0.003);

  const second = await migrateUsage({ configPath });
  assert.equal(second.written, 0);
  assert.equal(second.skippedExisting, 1);

  const dry = await migrateUsage({ configPath, force: true, dryRun: true });
  assert.equal(dry.written, 1);
});
