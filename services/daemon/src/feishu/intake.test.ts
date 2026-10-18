import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TriggerStore } from "../state/trigger-store.js";
import { FeishuIntake } from "./intake.js";

const botMention = {
  key: "@_user_1",
  id: { open_id: "ou_bot" },
  mentioned_type: "bot" as const,
  name: "Beacon",
};

const groupBotEvent = {
  event_id: "event-1",
  sender: { sender_type: "user", sender_id: { open_id: "user" } },
  message: {
    message_id: "message-1",
    chat_id: "chat-1",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "@_user_1 question" }),
    mentions: [botMention],
  },
};

test("durably claims before processing and ignores a duplicate event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-intake-"));
  const store = new TriggerStore(directory, "profile");
  const processed: string[] = [];
  const reactions: string[] = [];
  const clearedReactions: string[] = [];
  const intake = new FeishuIntake({
    store,
    process: async (triggerKey, normalize) => {
      const input = await normalize();
      processed.push(`${triggerKey}:${input.kind}`);
    },
    fetchMessage: async () => {
      throw new Error("no quote expected");
    },
    listThreadMessages: async () => {
      throw new Error("no thread expected");
    },
    acknowledge: async (messageId) => {
      reactions.push(messageId);
      return {
        clear: async () => {
          clearedReactions.push(messageId);
        },
      };
    },
    onFatal: (error) => {
      throw error;
    },
  });

  assert.equal(await intake.handle(groupBotEvent), "accepted");
  assert.equal(await intake.handle(groupBotEvent), "duplicate");
  await intake.drain();
  assert.equal(processed.length, 1);
  assert.deepEqual(reactions, ["message-1"]);
  assert.deepEqual(clearedReactions, ["message-1"]);
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
    listThreadMessages: async () => [],
    acknowledge: async () => ({ clear: async () => undefined }),
    onFatal: () => undefined,
  });
  await assert.rejects(
    intake.handle({ ...groupBotEvent, event_id: undefined }),
    /event_id is required/,
  );
});

test("clears the acknowledgement after processing fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-intake-"));
  const clearedReactions: string[] = [];
  let fatal: Error | undefined;
  const intake = new FeishuIntake({
    store: new TriggerStore(directory, "profile"),
    process: async () => {
      throw new Error("processing failed");
    },
    fetchMessage: async () => {
      throw new Error("unused");
    },
    listThreadMessages: async () => [],
    acknowledge: async (messageId) => ({
      clear: async () => {
        clearedReactions.push(messageId);
      },
    }),
    onFatal: (error) => {
      fatal = error;
    },
  });

  assert.equal(await intake.handle(groupBotEvent), "accepted");
  await assert.rejects(intake.drain(), /processing failed/);
  assert.deepEqual(clearedReactions, ["message-1"]);
  assert.match(fatal?.message ?? "", /processing failed/);
});

test("ignores pure @All group events before claim, ack, or agent run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-intake-"));
  const store = new TriggerStore(directory, "profile");
  let processed = 0;
  let acknowledged = 0;
  const intake = new FeishuIntake({
    store,
    process: async () => {
      processed += 1;
    },
    fetchMessage: async () => {
      throw new Error("unused");
    },
    listThreadMessages: async () => [],
    acknowledge: async () => {
      acknowledged += 1;
      return { clear: async () => undefined };
    },
    onFatal: (error) => {
      throw error;
    },
  });

  assert.equal(
    await intake.handle({
      event_id: "event-all",
      sender: { sender_type: "user", sender_id: { open_id: "user" } },
      message: {
        message_id: "message-all",
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_all announcement" }),
        mentions: [{ key: "@_all", name: "所有人" }],
      },
    }),
    "ignored",
  );
  await intake.drain();
  assert.equal(processed, 0);
  assert.equal(acknowledged, 0);
  assert.equal((await store.list()).length, 0);
});

test("includes topic thread history in the normalized feishu_message input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-intake-"));
  let normalized: unknown;
  const intake = new FeishuIntake({
    store: new TriggerStore(directory, "profile"),
    process: async (_triggerKey, normalize) => {
      normalized = await normalize();
    },
    fetchMessage: async (messageId) => ({
      messageId,
      messageType: "interactive",
      senderType: "app",
      senderId: "bot",
      content: JSON.stringify({ title: "alert" }),
      threadId: "omt_topic",
    }),
    listThreadMessages: async (threadId) => {
      assert.equal(threadId, "omt_topic");
      return [
        {
          messageId: "om_root",
          messageType: "interactive",
          senderType: "app",
          senderId: "bot",
          content: JSON.stringify({ title: "alert" }),
          threadId,
        },
        {
          messageId: "om_prior",
          messageType: "text",
          senderType: "user",
          senderId: "user",
          content: JSON.stringify({ text: "exclude 4xx" }),
          threadId,
        },
        {
          messageId: "om_current",
          messageType: "text",
          senderType: "user",
          senderId: "user",
          content: JSON.stringify({ text: "@_user_1 retry" }),
          threadId,
        },
      ];
    },
    acknowledge: async () => ({ clear: async () => undefined }),
    onFatal: (error) => {
      throw error;
    },
  });

  assert.equal(
    await intake.handle({
      event_id: "event-topic",
      sender: { sender_type: "user", sender_id: { open_id: "user" } },
      message: {
        message_id: "om_current",
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 retry" }),
        parent_id: "om_root",
        root_id: "om_root",
        thread_id: "omt_topic",
        mentions: [botMention],
      },
    }),
    "accepted",
  );
  await intake.drain();

  assert.deepEqual(normalized, {
    kind: "feishu_message",
    eventId: "event-topic",
    chatType: "group",
    quotedMessages: [
      {
        messageId: "om_root",
        messageType: "interactive",
        senderType: "app",
        senderId: "bot",
        content: { title: "alert" },
      },
    ],
    threadMessages: [
      {
        messageId: "om_root",
        messageType: "interactive",
        senderType: "app",
        senderId: "bot",
        content: { title: "alert" },
      },
      {
        messageId: "om_prior",
        messageType: "text",
        senderType: "user",
        senderId: "user",
        content: { text: "exclude 4xx" },
      },
    ],
    currentMessage: {
      messageId: "om_current",
      messageType: "text",
      senderType: "user",
      senderId: "user",
      content: { text: "@_user_1 retry" },
    },
  });
});

test("still accepts DM without mentions and @All plus bot mention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-intake-"));
  const processed: string[] = [];
  const intake = new FeishuIntake({
    store: new TriggerStore(directory, "profile"),
    process: async (triggerKey) => {
      processed.push(triggerKey);
    },
    fetchMessage: async () => {
      throw new Error("unused");
    },
    listThreadMessages: async () => [],
    acknowledge: async () => ({ clear: async () => undefined }),
    onFatal: (error) => {
      throw error;
    },
  });

  assert.equal(
    await intake.handle({
      event_id: "event-dm",
      sender: { sender_type: "user", sender_id: { open_id: "user" } },
      message: {
        message_id: "message-dm",
        chat_id: "chat-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    }),
    "accepted",
  );

  assert.equal(
    await intake.handle({
      event_id: "event-both",
      sender: { sender_type: "user", sender_id: { open_id: "user" } },
      message: {
        message_id: "message-both",
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_all @_user_1 both" }),
        mentions: [{ key: "@_all", name: "所有人" }, botMention],
      },
    }),
    "accepted",
  );

  await intake.drain();
  assert.equal(processed.length, 2);
});
