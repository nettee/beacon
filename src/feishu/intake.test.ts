import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TriggerStore } from "../state/trigger-store.js";
import { FeishuIntake } from "./intake.js";

const event = {
  event_id: "event-1",
  sender: { sender_type: "user", sender_id: { open_id: "user" } },
  message: {
    message_id: "message-1",
    chat_id: "chat-1",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "question" }),
  },
};

test("durably claims before processing and ignores a duplicate event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-intake-"));
  const store = new TriggerStore(directory, "profile");
  const processed: string[] = [];
  const reactions: string[] = [];
  const intake = new FeishuIntake({
    store,
    process: async (triggerKey, normalize) => {
      const input = await normalize();
      processed.push(`${triggerKey}:${input.kind}`);
    },
    fetchMessage: async () => {
      throw new Error("no quote expected");
    },
    acknowledge: async (messageId) => {
      reactions.push(messageId);
    },
    onFatal: (error) => {
      throw error;
    },
  });

  assert.equal(await intake.handle(event), "accepted");
  assert.equal(await intake.handle(event), "duplicate");
  await intake.drain();
  assert.equal(processed.length, 1);
  assert.deepEqual(reactions, ["message-1"]);
  assert.equal((await store.list()).length, 1);
});

test("fails instead of claiming a message without event_id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-intake-"));
  const intake = new FeishuIntake({
    store: new TriggerStore(directory, "profile"),
    process: async () => undefined,
    fetchMessage: async () => {
      throw new Error("unused");
    },
    acknowledge: async () => undefined,
    onFatal: () => undefined,
  });
  await assert.rejects(
    intake.handle({ ...event, event_id: undefined }),
    /event_id is required/,
  );
});
