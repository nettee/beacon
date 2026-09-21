import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Profile } from "./config/profile.js";
import type {
  DeliveryContent,
  DeliveryTarget,
  FinalOutcomeContent,
} from "./domain/types.js";
import { startOutcomeServer } from "./outcome/server.js";
import { RunOrchestrator } from "./run/orchestrator.js";
import type { AgentRuntimeRunner } from "./run/profile-runner.js";
import { RunQueue } from "./run/queue.js";
import { ScheduleCursorStore } from "./schedule/cursor-store.js";
import { triggerScheduleOnce } from "./schedule-trigger.js";
import { TriggerStore } from "./state/trigger-store.js";

async function setup(options?: {
  failRun?: boolean;
  failDelivery?: boolean;
  outcome?: FinalOutcomeContent;
}) {
  const directory = await mkdtemp(join(tmpdir(), "beacon-schedule-trigger-"));
  const profile: Profile = {
    id: "profile",
    directory,
    prompt: "System prompt",
    workspace: "/workspace",
    runtime: "pi",
    model: { provider: "test", id: "model" },
    admin: { chatId: "oc_admin" },
    schedules: [
      {
        id: "daily",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        input: "Prepare the daily report",
        notify: { chatId: "oc_group" },
      },
    ],
  };
  const store = new TriggerStore(directory, profile.id);
  const cursors = new ScheduleCursorStore(directory);
  const cursorTime = new Date("2026-09-14T01:00:00.000Z");
  await cursors.initialize("daily", cursorTime);
  const outcomes = await startOutcomeServer();
  const deliveries: Array<{
    target: DeliveryTarget;
    outcome: DeliveryContent;
  }> = [];
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
        options?.outcome ?? {
          reply: { kind: "text", text: "Daily result" },
        },
      );
      return { text: "ignored", provider: "test", model: "model" };
    },
    delivery: {
      async deliver(target, outcome) {
        deliveries.push({ target, outcome });
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
      assert.deepEqual(record.target, { kind: "chat", chatId: "oc_admin" });
      assert.deepEqual(record.notifyTarget, {
        kind: "chat",
        chatId: "oc_group",
      });
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
        target: { kind: "chat", chatId: "oc_admin" },
        outcome: { kind: "text", text: "Daily result" },
      },
      {
        target: { kind: "chat", chatId: "oc_admin" },
        outcome: { kind: "text", text: "Daily result" },
      },
    ]);
    assert.match(
      fixture.requests[0]?.prompt ?? "",
      /A configured Schedule triggered this Run[\s\S]*schedule_id: daily[\s\S]*Prepare the daily report/,
    );
    assert.match(
      fixture.requests[0]?.systemPrompt ?? "",
      /All local file reads, searches, and modifications must stay within the workspace directory and its descendants: \/workspace/,
    );
  } finally {
    await fixture.outcomes.close();
  }
});

for (const outcome of [
  { reply: { kind: "text" as const, text: "Daily result" } },
  {
    reply: { kind: "no_reply" as const, reason: "announced" },
    notify: {
      kind: "card" as const,
      title: "Daily result",
      content: "Completed",
      buttons: [],
    },
  },
  { reply: { kind: "no_reply" as const, reason: "Nothing to report" } },
] satisfies FinalOutcomeContent[]) {
  test(`accepts a ${outcome.notify ? "notify card" : outcome.reply.kind} Final Outcome`, async () => {
    const fixture = await setup({ outcome });
    try {
      const record = await triggerScheduleOnce({
        profile: fixture.profile,
        scheduleId: "daily",
        store: fixture.store,
        process: (triggerKey, normalize) =>
          fixture.orchestrator.process(triggerKey, normalize),
        id: () => (outcome.notify ? "card" : outcome.reply.kind),
      });

      assert.equal(record.run?.state, "succeeded");
      assert.deepEqual(record.finalOutcome?.content, outcome);
      assert.equal(
        record.delivery?.state,
        outcome.reply.kind === "text" ? "delivered" : undefined,
      );
      assert.equal(
        record.notifyDelivery?.state,
        outcome.notify ? "delivered" : undefined,
      );
    } finally {
      await fixture.outcomes.close();
    }
  });
}

test("accepts a completed Run with a Final Outcome when Delivery fails", async () => {
  const fixture = await setup({ failDelivery: true });
  try {
    const record = await triggerScheduleOnce({
      profile: fixture.profile,
      scheduleId: "daily",
      store: fixture.store,
      process: (triggerKey, normalize) =>
        fixture.orchestrator.process(triggerKey, normalize),
      id: () => "delivery-failed",
    });

    assert.equal(record.run?.state, "succeeded");
    assert.equal(record.finalOutcome?.content.reply.kind, "text");
    assert.equal(record.delivery?.state, "failed");
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

test("reports the run_id when the Run fails", async () => {
  const fixture = await setup({ failRun: true });
  try {
    await assert.rejects(
      triggerScheduleOnce({
        profile: fixture.profile,
        scheduleId: "daily",
        store: fixture.store,
        process: (triggerKey, normalize) =>
          fixture.orchestrator.process(triggerKey, normalize),
        id: () => "run",
      }),
      /run_id=run_generated-0.*runtime_exit_failed/,
    );
  } finally {
    await fixture.outcomes.close();
  }
});
