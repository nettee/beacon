import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Profile } from "./config/profile.js";
import type { DeliveryTarget } from "./domain/types.js";
import { startOutcomeServer } from "./outcome/server.js";
import { RunOrchestrator } from "./run/orchestrator.js";
import type { AgentRuntimeRunner } from "./run/profile-runner.js";
import { RunQueue } from "./run/queue.js";
import { ScheduleCursorStore } from "./schedule/cursor-store.js";
import { triggerScheduleOnce } from "./schedule-trigger.js";
import { TriggerStore } from "./state/trigger-store.js";

async function setup(options?: { failRun?: boolean; failDelivery?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "beacon-schedule-trigger-"));
  const profile: Profile = {
    id: "profile",
    directory,
    prompt: "System prompt",
    workspace: "/workspace",
    runtime: "pi",
    model: { provider: "test", id: "model" },
    schedules: [
      {
        id: "daily",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        input: "Prepare the daily report",
        delivery: { chatId: "oc_target" },
      },
    ],
  };
  const store = new TriggerStore(directory, profile.id);
  const cursors = new ScheduleCursorStore(directory);
  const cursorTime = new Date("2026-09-14T01:00:00.000Z");
  await cursors.initialize("daily", cursorTime);
  const outcomes = await startOutcomeServer();
  const deliveries: Array<{ target: DeliveryTarget; text: string }> = [];
  const requests: Parameters<AgentRuntimeRunner>[0][] = [];
  const orchestrator = new RunOrchestrator({
    profile,
    store,
    queue: new RunQueue(1, 1),
    outcomes,
    beaconCliPath: "/beacon",
    sessionDirectory: "/sessions",
    id: (() => {
      let next = 0;
      return () => `generated-${next++}`;
    })(),
    runAgent: async (request) => {
      requests.push(request);
      if (options?.failRun) throw new Error("runtime unavailable");
      const { submitOutcome } = await import("./outcome/submit.js");
      if (!request.outcome) throw new Error("missing outcome binding");
      await submitOutcome(
        request.outcome.socketPath,
        request.outcome.runToken,
        "Daily result",
      );
      return { text: "ignored", provider: "test", model: "model" };
    },
    delivery: {
      async deliver(target, text) {
        deliveries.push({ target, text });
        if (options?.failDelivery) throw new Error("delivery unavailable");
        return {};
      },
    },
  });
  return {
    profile,
    store,
    cursors,
    cursorTime,
    outcomes,
    deliveries,
    requests,
    orchestrator,
  };
}

test("runs a Schedule twice with distinct manual source keys and leaves its cursor unchanged", async () => {
  const fixture = await setup();
  try {
    for (const [index, invocationId] of ["first", "second"].entries()) {
      const now = new Date(`2026-09-15T0${index + 1}:00:00.000Z`);
      const record = await triggerScheduleOnce({
        profile: fixture.profile,
        scheduleId: "daily",
        store: fixture.store,
        process: (triggerKey, normalize) =>
          fixture.orchestrator.process(triggerKey, normalize),
        now: () => now,
        id: () => invocationId,
      });
      assert.deepEqual(record.sourceKey, [
        "manual-schedule",
        "daily",
        invocationId,
      ]);
      assert.deepEqual(record.target, { kind: "chat", chatId: "oc_target" });
      assert.deepEqual(record.input, {
        kind: "schedule",
        scheduleId: "daily",
        scheduledFor: now.toISOString(),
        text: "Prepare the daily report",
      });
    }

    assert.equal((await fixture.store.list()).length, 2);
    assert.equal(
      (await fixture.cursors.read("daily"))?.through,
      fixture.cursorTime.toISOString(),
    );
    assert.deepEqual(fixture.deliveries, [
      {
        target: { kind: "chat", chatId: "oc_target" },
        text: "Daily result",
      },
      {
        target: { kind: "chat", chatId: "oc_target" },
        text: "Daily result",
      },
    ]);
    assert.match(
      fixture.requests[0]?.prompt ?? "",
      /A configured Schedule triggered this Run[\s\S]*schedule_id: daily[\s\S]*Prepare the daily report/,
    );
  } finally {
    await fixture.outcomes.close();
  }
});

test("rejects an unknown Schedule before creating a Trigger", async () => {
  const fixture = await setup();
  try {
    await assert.rejects(
      triggerScheduleOnce({
        profile: fixture.profile,
        scheduleId: "unknown",
        store: fixture.store,
        process: (triggerKey, normalize) =>
          fixture.orchestrator.process(triggerKey, normalize),
      }),
      /Unknown Schedule.*unknown/,
    );
    assert.deepEqual(await fixture.store.list(), []);
  } finally {
    await fixture.outcomes.close();
  }
});

for (const failure of ["run", "delivery"] as const) {
  test(`reports the run_id when ${failure} fails`, async () => {
    const fixture = await setup({
      failRun: failure === "run",
      failDelivery: failure === "delivery",
    });
    try {
      await assert.rejects(
        triggerScheduleOnce({
          profile: fixture.profile,
          scheduleId: "daily",
          store: fixture.store,
          process: (triggerKey, normalize) =>
            fixture.orchestrator.process(triggerKey, normalize),
          id: () => failure,
        }),
        failure === "run"
          ? /run_id=run_generated-0.*runtime_exit_failed/
          : /run_id=run_generated-0.*delivery_api_failed/,
      );
    } finally {
      await fixture.outcomes.close();
    }
  });
}
