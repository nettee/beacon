import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Profile } from "../config/profile.js";
import type { FinalOutcomeContent } from "../domain/types.js";
import { MISSING_REPLY_OUTCOME_SUMMARY } from "../outcome/content.js";
import { startOutcomeServer } from "../outcome/server.js";
import { buildAgentSystemPrompt } from "../runtime/system-prompt.js";
import { TriggerStore } from "../state/trigger-store.js";
import { formatFailureReplyText, RunOrchestrator } from "./orchestrator.js";
import type { AgentRuntimeRunner } from "./profile-runner.js";
import { RunQueue } from "./queue.js";

const profile: Profile = {
  id: "profile",
  directory: "/profile",
  persona: "Persona text.",
  task: "Task text.",
  workspace: "/workspace",
  runtime: "pi",
  model: { provider: "test", id: "model" },
  schedules: [],
};

async function setup(
  deliver?: () => Promise<void>,
  agentOutcome: FinalOutcomeContent = {
    reply: { kind: "text", text: "answer" },
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "beacon-orchestrator-"));
  const store = new TriggerStore(directory, profile.id);
  const claim = await store.claim({
    sourceKey: ["feishu", "event"],
    target: { kind: "reply", messageId: "message" },
  });
  const outcomes = await startOutcomeServer();
  const deliveries: FinalOutcomeContent[] = [];
  const requests: Parameters<AgentRuntimeRunner>[0][] = [];
  const orchestrator = new RunOrchestrator({
    profile,
    store,
    queue: new RunQueue(1, 1),
    outcomes,
    beaconCliPath: "/beacon",
    sessionDirectory: "/beacon-sessions",
    runAgent: async (request) => {
      requests.push(request);
      const { submitOutcome } = await import("../outcome/submit.js");
      if (!request.outcome) throw new Error("missing outcome binding");
      await submitOutcome(
        request.outcome.socketPath,
        request.outcome.runToken,
        agentOutcome,
      );
      return { text: "ignored", provider: "test", model: "model" };
    },
    delivery: {
      async deliver(_target, outcome) {
        deliveries.push(outcome);
        if (deliver) await deliver();
        return {};
      },
    },
  });
  return { store, claim, outcomes, orchestrator, deliveries, requests };
}

const input = {
  kind: "feishu_message" as const,
  eventId: "event",
  chatType: "p2p" as const,
  quotedMessages: [],
  currentMessage: {
    messageId: "message",
    messageType: "text",
    senderType: "user",
    content: { text: "question" },
  },
};

test("persists a successful Run and quoted Delivery", async () => {
  const fixture = await setup();
  try {
    await fixture.orchestrator.process(
      fixture.claim.record.triggerKey,
      async () => input,
    );
    const [record] = await fixture.store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.equal(record?.run?.sessionId, record?.run?.runId);
    assert.equal(
      record?.run?.sessionPath,
      `/beacon-sessions/profile/${record?.run?.runId}`,
    );
    assert.equal(
      record?.run?.systemPrompt,
      buildAgentSystemPrompt(profile, {
        kind: "feishu_message",
        notify: false,
      }),
    );
    assert.deepEqual(fixture.requests[0]?.session, {
      id: record?.run?.runId,
      path: `/beacon-sessions/profile/${record?.run?.runId}`,
      name: `Beacon profile ${record?.run?.runId}`,
    });
    assert.equal(fixture.requests[0]?.systemPrompt, record?.run?.systemPrompt);
    assert.deepEqual(record?.finalOutcome?.content, {
      reply: { kind: "text", text: "answer" },
    });
    assert.equal(record?.delivery?.state, "delivered");
    assert.deepEqual(fixture.deliveries, [{ kind: "text", text: "answer" }]);
    assert.equal(record?.feedback, undefined);
  } finally {
    await fixture.outcomes.close();
  }
});

test("keeps Run success when Delivery fails", async () => {
  const fixture = await setup(async () => {
    throw new Error("forbidden");
  });
  try {
    await fixture.orchestrator.process(
      fixture.claim.record.triggerKey,
      async () => input,
    );
    const [record] = await fixture.store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.equal(record?.delivery?.state, "failed");
    assert.equal(record?.delivery?.failure?.code, "delivery_api_failed");
  } finally {
    await fixture.outcomes.close();
  }
});

test("rewrites inbound no_reply into an out-of-role text reply", async () => {
  const noReply: FinalOutcomeContent = {
    reply: { kind: "no_reply", reason: "unrelated group announcement" },
  };
  const fixture = await setup(undefined, noReply);
  try {
    await fixture.orchestrator.process(
      fixture.claim.record.triggerKey,
      async () => input,
    );
    const [record] = await fixture.store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.deepEqual(record?.finalOutcome?.content, {
      reply: {
        kind: "text",
        text: "这条消息不在我的职责范围内。",
      },
    });
    assert.equal(record?.delivery?.state, "delivered");
    assert.deepEqual(fixture.deliveries, [
      { kind: "text", text: "这条消息不在我的职责范围内。" },
    ]);
  } finally {
    await fixture.outcomes.close();
  }
});

test("marks an interrupted Run failed without running the Agent again", async () => {
  const fixture = await setup();
  try {
    const runId = "run_interrupted";
    await fixture.store.update(fixture.claim.record.triggerKey, (record) => ({
      ...record,
      input,
      run: {
        runId,
        state: "running",
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        provider: "test",
        model: "model",
        workspace: "/workspace",
        promptDigest: "0".repeat(64),
      },
    }));

    await fixture.orchestrator.recover();
    const [record] = await fixture.store.list();
    assert.equal(record?.run?.state, "failed");
    assert.equal(record?.run?.failure?.code, "service_interrupted");
    assert.equal(record?.finalOutcome?.origin, "beacon_failure");
    assert.equal(record?.delivery?.state, "delivered");
  } finally {
    await fixture.outcomes.close();
  }
});

test("migrates a legacy queued Run to its deterministic Pi session on recovery", async () => {
  const fixture = await setup();
  try {
    const runId = "run_legacy";
    await fixture.store.update(fixture.claim.record.triggerKey, (record) => ({
      ...record,
      input,
      run: {
        runId,
        state: "queued",
        queuedAt: new Date().toISOString(),
        provider: "test",
        model: "model",
        workspace: "/workspace",
        promptDigest: "0".repeat(64),
      },
    }));

    await fixture.orchestrator.recover();
    const [record] = await fixture.store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.equal(record?.run?.sessionId, runId);
    assert.equal(record?.run?.sessionPath, `/beacon-sessions/profile/${runId}`);
    assert.equal(fixture.requests[0]?.session?.id, runId);
    assert.equal(
      record?.run?.systemPrompt,
      buildAgentSystemPrompt(profile, {
        kind: "feishu_message",
        notify: false,
      }),
    );
    assert.equal(fixture.requests[0]?.systemPrompt, record?.run?.systemPrompt);
  } finally {
    await fixture.outcomes.close();
  }
});

test("reuses a stored systemPrompt instead of rebuilding it", async () => {
  const fixture = await setup();
  try {
    const runId = "run_stored_prompt";
    const stored = "exact --system-prompt from this Run";
    await fixture.store.update(fixture.claim.record.triggerKey, (record) => ({
      ...record,
      input,
      run: {
        runId,
        state: "queued",
        queuedAt: new Date().toISOString(),
        provider: "test",
        model: "model",
        workspace: "/workspace",
        promptDigest: "0".repeat(64),
        systemPrompt: stored,
      },
    }));

    await fixture.orchestrator.recover();
    const [record] = await fixture.store.list();
    assert.equal(record?.run?.systemPrompt, stored);
    assert.equal(fixture.requests[0]?.systemPrompt, stored);
  } finally {
    await fixture.outcomes.close();
  }
});

test("skips recovery of a delivered legacy card without notify target", async () => {
  const fixture = await setup();
  try {
    await fixture.store.update(fixture.claim.record.triggerKey, (record) => ({
      ...record,
      input,
      run: {
        runId: "run_legacy_card",
        state: "succeeded",
        queuedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        provider: "test",
        model: "model",
        workspace: "/workspace",
        promptDigest: "0".repeat(64),
      },
      finalOutcome: {
        origin: "agent",
        content: {
          kind: "card",
          title: "AMR 生产发布影响报告",
          content: "already sent",
        },
        submittedAt: new Date().toISOString(),
      },
      delivery: {
        deliveryId: "delivery",
        target: record.target,
        state: "delivered",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    }));

    await fixture.orchestrator.recover();
    const [record] = await fixture.store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.equal(record?.delivery?.state, "delivered");
    assert.equal(record?.notifyDelivery, undefined);
    assert.equal(fixture.deliveries.length, 0);
  } finally {
    await fixture.outcomes.close();
  }
});

test("does not resend a Delivery interrupted after its external call began", async () => {
  const fixture = await setup();
  try {
    await fixture.store.update(fixture.claim.record.triggerKey, (record) => ({
      ...record,
      input,
      run: {
        runId: "run_success",
        state: "succeeded",
        queuedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        provider: "test",
        model: "model",
        workspace: "/workspace",
        promptDigest: "0".repeat(64),
      },
      finalOutcome: {
        origin: "agent",
        content: { reply: { kind: "text", text: "answer" } },
        submittedAt: new Date().toISOString(),
      },
      delivery: {
        deliveryId: "delivery",
        target: record.target,
        state: "delivering",
        startedAt: new Date().toISOString(),
      },
    }));

    await fixture.orchestrator.recover();
    const [record] = await fixture.store.list();
    assert.equal(record?.delivery?.state, "failed");
    assert.equal(record?.delivery?.failure?.code, "delivery_interrupted");
    assert.equal(fixture.deliveries.length, 0);
  } finally {
    await fixture.outcomes.close();
  }
});

test("persists capacity_exceeded without starting another Agent Run", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "beacon-orchestrator-capacity-"),
  );
  const store = new TriggerStore(directory, profile.id);
  const claim = await store.claim({
    sourceKey: ["feishu", "capacity-event"],
    target: { kind: "reply", messageId: "message" },
  });
  const outcomes = await startOutcomeServer();
  const queue = new RunQueue(1, 0);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const occupying = queue.enqueue(() => blocked);
  assert.equal(occupying.accepted, true);
  let runCount = 0;
  const orchestrator = new RunOrchestrator({
    profile,
    store,
    queue,
    outcomes,
    beaconCliPath: "/beacon",
    sessionDirectory: "/beacon-sessions",
    runAgent: async () => {
      runCount += 1;
      return { text: "unused", provider: "test", model: "model" };
    },
    delivery: {
      async deliver() {
        return {};
      },
    },
  });
  try {
    await orchestrator.process(claim.record.triggerKey, async () => input);
    const [record] = await store.list();
    assert.equal(runCount, 0);
    assert.equal(record?.run?.state, "failed");
    assert.equal(record?.run?.failure?.code, "capacity_exceeded");
    assert.equal(record?.delivery?.state, "delivered");
  } finally {
    release();
    if (occupying.accepted) await occupying.completion;
    await outcomes.close();
  }
});

const scheduleInput = {
  kind: "schedule" as const,
  scheduleId: "daily",
  scheduledFor: "2026-09-21T02:00:00.000Z",
  text: "Prepare the daily report",
};

test("delivers a schedule notify card without an admin reply", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "beacon-orchestrator-notify-"),
  );
  const scheduled: Profile = {
    ...profile,
    admin: { chatId: "oc_admin" },
    schedules: [
      {
        id: "daily",
        cron: "0 10 * * 1-5",
        timezone: "Asia/Shanghai",
        input: "Prepare the daily report",
        notify: { chatId: "oc_group" },
      },
    ],
  };
  const store = new TriggerStore(directory, scheduled.id);
  const claim = await store.claim({
    sourceKey: ["schedule", "daily", scheduleInput.scheduledFor],
    target: { kind: "chat", chatId: "oc_admin" },
    notifyTarget: { kind: "chat", chatId: "oc_group" },
  });
  const outcomes = await startOutcomeServer();
  const deliveries: Array<{
    target: { kind: string };
    outcome: { kind: string };
  }> = [];
  const card = {
    kind: "card" as const,
    title: "Report",
    content: "- completed",
    buttons: [] as Array<{ label: string; url: string }>,
  };
  const orchestrator = new RunOrchestrator({
    profile: scheduled,
    store,
    queue: new RunQueue(1, 1),
    outcomes,
    beaconCliPath: "/beacon",
    sessionDirectory: "/beacon-sessions",
    runAgent: async (request) => {
      const { submitOutcome } = await import("../outcome/submit.js");
      if (!request.outcome) throw new Error("missing outcome binding");
      await submitOutcome(
        request.outcome.socketPath,
        request.outcome.runToken,
        {
          notify: card,
        },
      );
      await submitOutcome(
        request.outcome.socketPath,
        request.outcome.runToken,
        {
          reply: { kind: "no_reply", reason: "group card is enough" },
        },
      );
      return { text: "ignored", provider: "test", model: "model" };
    },
    delivery: {
      async deliver(target, outcome) {
        deliveries.push({ target, outcome });
        return {};
      },
    },
  });
  try {
    await orchestrator.process(
      claim.record.triggerKey,
      async () => scheduleInput,
    );
    const [record] = await store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.equal(record?.delivery, undefined);
    assert.equal(record?.notifyDelivery?.state, "delivered");
    assert.match(record?.run?.systemPrompt ?? "", /This Run is Schedule daily/);
    assert.match(
      record?.run?.systemPrompt ?? "",
      /You may also call `notify_card` at most once/,
    );
    assert.deepEqual(deliveries, [
      { target: { kind: "chat", chatId: "oc_group" }, outcome: card },
    ]);
  } finally {
    await outcomes.close();
  }
});

test("keeps a schedule no_reply silent", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "beacon-orchestrator-silent-"),
  );
  const scheduled: Profile = {
    ...profile,
    admin: { chatId: "oc_admin" },
    schedules: [
      {
        id: "daily",
        cron: "0 * * * *",
        timezone: "Asia/Shanghai",
        input: "scan",
      },
    ],
  };
  const store = new TriggerStore(directory, scheduled.id);
  const claim = await store.claim({
    sourceKey: ["schedule", "daily", scheduleInput.scheduledFor],
    target: { kind: "chat", chatId: "oc_admin" },
  });
  const outcomes = await startOutcomeServer();
  const deliveries: unknown[] = [];
  const orchestrator = new RunOrchestrator({
    profile: scheduled,
    store,
    queue: new RunQueue(1, 1),
    outcomes,
    beaconCliPath: "/beacon",
    sessionDirectory: "/beacon-sessions",
    runAgent: async (request) => {
      const { submitOutcome } = await import("../outcome/submit.js");
      if (!request.outcome) throw new Error("missing outcome binding");
      await submitOutcome(
        request.outcome.socketPath,
        request.outcome.runToken,
        {
          reply: { kind: "no_reply", reason: "nothing to report" },
        },
      );
      return { text: "ignored", provider: "test", model: "model" };
    },
    delivery: {
      async deliver(_target, outcome) {
        deliveries.push(outcome);
        return {};
      },
    },
  });
  try {
    await orchestrator.process(
      claim.record.triggerKey,
      async () => scheduleInput,
    );
    const [record] = await store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.equal(record?.delivery, undefined);
    assert.match(record?.run?.systemPrompt ?? "", /Do not call `notify_card`/);
    assert.doesNotMatch(
      record?.run?.systemPrompt ?? "",
      /You may also call `notify_card`/,
    );
    assert.deepEqual(deliveries, []);
  } finally {
    await outcomes.close();
  }
});

test("persists submit_feedback items without blocking Delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-orchestrator-fb-"));
  const store = new TriggerStore(directory, profile.id);
  const claim = await store.claim({
    sourceKey: ["feishu", "event-feedback"],
    target: { kind: "reply", messageId: "message" },
  });
  const outcomes = await startOutcomeServer();
  const orchestrator = new RunOrchestrator({
    profile,
    store,
    queue: new RunQueue(1, 1),
    outcomes,
    beaconCliPath: "/beacon",
    sessionDirectory: "/beacon-sessions",
    runAgent: async (request) => {
      const { submitOutcome } = await import("../outcome/submit.js");
      if (!request.outcome) throw new Error("missing outcome binding");
      await submitOutcome(
        request.outcome.socketPath,
        request.outcome.runToken,
        {
          feedback: {
            items: [
              {
                priority: "high",
                summary: "GRAFANA_READER_TOKEN_PROD is unset.",
              },
            ],
          },
        },
      );
      await submitOutcome(
        request.outcome.socketPath,
        request.outcome.runToken,
        { reply: { kind: "text", text: "answer" } },
      );
      return { text: "ignored", provider: "test", model: "model" };
    },
    delivery: {
      async deliver() {
        return {};
      },
    },
  });
  try {
    await orchestrator.process(claim.record.triggerKey, async () => input);
    const [record] = await store.list();
    assert.equal(record?.run?.state, "succeeded");
    assert.equal(record?.delivery?.state, "delivered");
    assert.equal(record?.feedback?.items.length, 1);
    assert.equal(record?.feedback?.items[0]?.priority, "high");
    assert.equal(typeof record?.feedback?.submittedAt, "string");
  } finally {
    await outcomes.close();
  }
});

test("fails with outcome_missing and a clear admin reply when Agent settles without reply/no_reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-orchestrator-miss-"));
  const store = new TriggerStore(directory, profile.id);
  const claim = await store.claim({
    sourceKey: ["schedule", "hourly"],
    target: { kind: "chat", chatId: "oc_admin" },
  });
  const outcomes = await startOutcomeServer();
  const deliveries: FinalOutcomeContent[] = [];
  const orchestrator = new RunOrchestrator({
    profile: {
      ...profile,
      admin: { chatId: "oc_admin" },
      schedules: [
        {
          id: "hourly",
          cron: "0 * * * *",
          timezone: "Asia/Shanghai",
          input: "Detect",
        },
      ],
    },
    store,
    queue: new RunQueue(1, 1),
    outcomes,
    beaconCliPath: "/beacon",
    sessionDirectory: "/beacon-sessions",
    runAgent: async () => {
      // Agent thinks about no_reply but never submits an Outcome tool call.
      return { text: "thinking only", provider: "test", model: "model" };
    },
    delivery: {
      async deliver(_target, outcome) {
        deliveries.push(outcome);
        return {};
      },
    },
  });
  try {
    await orchestrator.process(claim.record.triggerKey, async () => ({
      kind: "schedule" as const,
      scheduleId: "hourly",
      scheduledFor: "2026-09-23T15:00:00.000Z",
      text: "Detect",
    }));
    const [record] = await store.list();
    assert.equal(record?.run?.state, "failed");
    assert.equal(record?.run?.failure?.code, "outcome_missing");
    assert.equal(record?.run?.failure?.summary, MISSING_REPLY_OUTCOME_SUMMARY);
    assert.equal(record?.finalOutcome?.origin, "beacon_failure");
    assert.equal(
      record?.finalOutcome?.content.reply.kind === "text"
        ? record.finalOutcome.content.reply.text
        : undefined,
      formatFailureReplyText(record!.run!.runId, {
        code: "outcome_missing",
        summary: MISSING_REPLY_OUTCOME_SUMMARY,
      }),
    );
    assert.match(
      deliveries[0] && "text" in deliveries[0] ? deliveries[0].text : "",
      /期望恰好调用一次 `reply` 或 `no_reply`/,
    );
    assert.match(
      deliveries[0] && "text" in deliveries[0] ? deliveries[0].text : "",
      /两者均未提交/,
    );
  } finally {
    await outcomes.close();
  }
});
