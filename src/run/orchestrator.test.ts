import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Profile } from "../config/profile.js";
import type { FinalOutcomeContent } from "../domain/types.js";
import { startOutcomeServer } from "../outcome/server.js";
import { TriggerStore } from "../state/trigger-store.js";
import { RunOrchestrator } from "./orchestrator.js";
import type { AgentRuntimeRunner } from "./profile-runner.js";
import { RunQueue } from "./queue.js";

const profile: Profile = {
  id: "profile",
  directory: "/profile",
  prompt: "System prompt",
  workspace: "/workspace",
  runtime: "pi",
  model: { provider: "test", id: "model" },
  schedules: [],
};

async function setup(
  deliver?: () => Promise<void>,
  agentOutcome: FinalOutcomeContent = { kind: "text", text: "answer" },
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
    assert.deepEqual(fixture.requests[0]?.session, {
      id: record?.run?.runId,
      path: `/beacon-sessions/profile/${record?.run?.runId}`,
      name: `Beacon profile ${record?.run?.runId}`,
    });
    assert.deepEqual(record?.finalOutcome?.content, {
      kind: "text",
      text: "answer",
    });
    assert.equal(record?.delivery?.state, "delivered");
    assert.deepEqual(fixture.deliveries, [{ kind: "text", text: "answer" }]);
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

test("persists and delivers an explicit card Final Outcome", async () => {
  const card: FinalOutcomeContent = {
    kind: "card",
    title: "Report",
    content: "- completed",
    buttons: [{ label: "Open", url: "https://example.com" }],
  };
  const fixture = await setup(undefined, card);
  try {
    await fixture.orchestrator.process(
      fixture.claim.record.triggerKey,
      async () => input,
    );
    const [record] = await fixture.store.list();
    assert.deepEqual(record?.finalOutcome?.content, card);
    assert.deepEqual(fixture.deliveries, [card]);
    assert.equal(record?.delivery?.state, "delivered");
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
        content: { kind: "text", text: "answer" },
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
