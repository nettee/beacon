import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TriggerStore } from "./trigger-store.js";

test("atomically claims a Feishu event across store instances", async () => {
  const profile = await mkdtemp(join(tmpdir(), "beacon-trigger-store-"));
  const first = new TriggerStore(profile, "profile");
  const second = new TriggerStore(profile, "profile");
  const request = {
    sourceKey: ["feishu", "event-1"],
    target: { kind: "reply" as const, messageId: "message-1" },
    ingress: { messageId: "message-1", content: "hello" },
  };

  const [left, right] = await Promise.all([
    first.claim(request),
    second.claim(request),
  ]);
  assert.equal([left.created, right.created].filter(Boolean).length, 1);
  assert.equal(left.record.triggerKey, right.record.triggerKey);
  assert.equal((await first.list()).length, 1);
});

test("atomically replaces and validates a Trigger snapshot", async () => {
  const profile = await mkdtemp(join(tmpdir(), "beacon-trigger-store-"));
  const store = new TriggerStore(profile, "profile");
  const claimed = await store.claim({
    sourceKey: ["feishu", "event-2"],
    target: { kind: "reply", messageId: "message-2" },
    ingress: { messageId: "message-2" },
  });

  const updated = await store.update(claimed.record.triggerKey, (record) => ({
    ...record,
    input: {
      kind: "feishu_message",
      eventId: "event-2",
      chatType: "p2p",
      quotedMessages: [],
      currentMessage: {
        messageId: "message-2",
        messageType: "text",
        senderType: "user",
        content: { text: "hello" },
      },
    },
  }));
  assert.equal(updated.input?.kind, "feishu_message");

  const raw = await readFile(
    store.recordPath(claimed.record.triggerKey),
    "utf8",
  );
  assert.equal(JSON.parse(raw).ingress.messageId, "message-2");
});

test("fails observably on a corrupt existing claim", async () => {
  const profile = await mkdtemp(join(tmpdir(), "beacon-trigger-store-"));
  const store = new TriggerStore(profile, "profile");
  const claimed = await store.claim({
    sourceKey: ["feishu", "event-3"],
    target: { kind: "reply", messageId: "message-3" },
  });
  await writeFile(store.recordPath(claimed.record.triggerKey), "not-json");

  await assert.rejects(
    store.claim({
      sourceKey: ["feishu", "event-3"],
      target: { kind: "reply", messageId: "message-3" },
    }),
    /Cannot parse Trigger record/,
  );
});

test("loads legacy text-only Final Outcomes as explicit text content", async () => {
  const profile = await mkdtemp(join(tmpdir(), "beacon-trigger-store-"));
  const store = new TriggerStore(profile, "profile");
  const claimed = await store.claim({
    sourceKey: ["manual", "legacy-outcome"],
    target: { kind: "local_stdout" },
  });
  const path = store.recordPath(claimed.record.triggerKey);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.finalOutcome = {
    origin: "agent",
    text: "legacy answer",
    submittedAt: new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(legacy)}\n`);

  const [record] = await store.list();
  assert.deepEqual(record?.finalOutcome?.content, {
    reply: { kind: "text", text: "legacy answer" },
  });
});

test("rejects a Run record whose Pi session does not map to its Run ID", async () => {
  const profile = await mkdtemp(join(tmpdir(), "beacon-trigger-store-"));
  const store = new TriggerStore(profile, "profile");
  const claimed = await store.claim({
    sourceKey: ["manual", "event-4"],
    target: { kind: "local_stdout" },
  });

  await assert.rejects(
    store.update(claimed.record.triggerKey, (record) => ({
      ...record,
      run: {
        runId: "run_expected",
        sessionId: "run_other",
        sessionPath: "/sessions/profile/run_expected",
        state: "queued",
        queuedAt: new Date().toISOString(),
        provider: "test",
        model: "model",
        workspace: "/workspace",
        promptDigest: "0".repeat(64),
      },
    })),
    /session identity must map/,
  );
});

test("persists and reloads an optional Run systemPrompt", async () => {
  const profile = await mkdtemp(join(tmpdir(), "beacon-trigger-store-"));
  const store = new TriggerStore(profile, "profile");
  const claimed = await store.claim({
    sourceKey: ["manual", "event-5"],
    target: { kind: "local_stdout" },
  });
  const updated = await store.update(claimed.record.triggerKey, (record) => ({
    ...record,
    run: {
      runId: "run_prompt",
      sessionId: "run_prompt",
      sessionPath: "/sessions/profile/run_prompt",
      state: "queued",
      queuedAt: new Date().toISOString(),
      provider: "test",
      model: "model",
      workspace: "/workspace",
      promptDigest: "0".repeat(64),
      systemPrompt: "stored --system-prompt text",
    },
  }));
  assert.equal(updated.run?.systemPrompt, "stored --system-prompt text");
  const [loaded] = await store.list();
  assert.equal(loaded?.run?.systemPrompt, "stored --system-prompt text");
});

test("persists and reloads a Run feedback record or explicit null", async () => {
  const profile = await mkdtemp(join(tmpdir(), "beacon-trigger-store-"));
  const store = new TriggerStore(profile, "profile");
  const claimed = await store.claim({
    sourceKey: ["manual", "event-6"],
    target: { kind: "local_stdout" },
  });
  const withNull = await store.update(claimed.record.triggerKey, (record) => ({
    ...record,
    feedback: null,
  }));
  assert.equal(withNull.feedback, null);
  const submitted = await store.update(claimed.record.triggerKey, (record) => ({
    ...record,
    feedback: {
      items: [
        {
          priority: "medium" as const,
          category: "skill" as const,
          summary: "detect-new-model.md never names the catalog path.",
        },
      ],
      submittedAt: "2026-09-22T02:00:00.000Z",
    },
  }));
  assert.equal(submitted.feedback?.items.length, 1);
  const [loaded] = await store.list();
  assert.equal(loaded?.feedback?.items[0]?.category, "skill");
});
