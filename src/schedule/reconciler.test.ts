import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Profile } from "../config/profile.js";
import { TriggerStore } from "../state/trigger-store.js";
import { ScheduleCursorStore } from "./cursor-store.js";
import { ScheduleReconciler } from "./reconciler.js";

const profile: Profile = {
  id: "profile",
  directory: "/unused",
  prompt: "prompt",
  workspace: "/workspace",
  runtime: "pi",
  model: { provider: "test", id: "model" },
  schedules: [
    {
      id: "daily",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      input: "report",
      delivery: { chatId: "chat" },
    },
  ],
};

test("coalesces missed occurrences into the latest durable Schedule Trigger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-scheduler-"));
  const triggers = new TriggerStore(directory, profile.id);
  const cursors = new ScheduleCursorStore(directory);
  await cursors.initialize("daily", new Date("2026-09-10T00:00:00Z"));
  const processed: string[] = [];
  const reconciler = new ScheduleReconciler({
    profile,
    triggers,
    cursors,
    maxOccurrences: 10,
    process: async (_key, normalize) => {
      const input = await normalize();
      if (input.kind === "schedule") processed.push(input.scheduledFor);
    },
  });

  await reconciler.reconcile(new Date("2026-09-12T02:00:00Z"));
  assert.deepEqual(processed, ["2026-09-12T01:00:00.000Z"]);
  assert.equal((await triggers.list()).length, 1);
  assert.equal(
    (await cursors.read("daily"))?.through,
    "2026-09-12T01:00:00.000Z",
  );

  await reconciler.reconcile(new Date("2026-09-12T02:00:00Z"));
  assert.equal(processed.length, 1);
});

test("initializes a new Schedule at now without historical backfill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-scheduler-"));
  const cursors = new ScheduleCursorStore(directory);
  const reconciler = new ScheduleReconciler({
    profile,
    triggers: new TriggerStore(directory, profile.id),
    cursors,
    maxOccurrences: 10,
    process: async () => assert.fail("must not process"),
  });
  const now = new Date("2026-09-12T02:00:00Z");
  await reconciler.reconcile(now);
  assert.equal((await cursors.read("daily"))?.through, now.toISOString());
});
