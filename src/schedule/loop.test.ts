import assert from "node:assert/strict";
import test from "node:test";

import type { Profile } from "../config/profile.js";
import { ScheduleLoop } from "./loop.js";

const profile: Profile = {
  id: "profile",
  directory: "/profile",
  prompt: "prompt",
  workspace: "/workspace",
  runtime: "pi",
  model: { provider: "test", id: "model" },
  schedules: [
    {
      id: "every",
      cron: "* * * * *",
      timezone: "UTC",
      input: "run",
      delivery: { chatId: "chat" },
    },
  ],
};

test("drains an in-flight reconciliation during shutdown", async () => {
  let timerCallback: (() => void) | undefined;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    timerCallback = callback;
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout;

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconciler = { reconcile: async () => blocked };
  try {
    const loop = new ScheduleLoop(profile, reconciler, (error) =>
      assert.fail(error.message),
    );
    loop.start(new Date("2026-09-13T00:00:00.000Z"));
    assert.ok(timerCallback);
    timerCallback();
    loop.stop();
    let drained = false;
    const drain = loop.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    release();
    await drain;
    assert.equal(drained, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
