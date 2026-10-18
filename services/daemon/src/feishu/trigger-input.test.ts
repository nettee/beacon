import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFeishuTriggerInput,
  type FetchedMessage,
} from "./trigger-input.js";

const baseInbound = {
  messageId: "current-message",
  chatId: "chat",
  chatType: "p2p",
  senderId: "sender",
  senderType: "user",
  messageType: "text",
  content: JSON.stringify({ text: "follow up" }),
};

const unusedList = async (): Promise<FetchedMessage[]> => {
  throw new Error("must not list thread messages");
};

test("normalizes a message without fetching quoted or thread context", async () => {
  let fetched = false;
  const result = await buildFeishuTriggerInput(baseInbound, {
    fetchMessage: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
    listThreadMessages: unusedList,
  });

  assert.equal(fetched, false);
  assert.deepEqual(result.message.content, { text: "follow up" });
  assert.deepEqual(result.quotedMessages, []);
  assert.deepEqual(result.threadMessages, []);
});

test("records the complete quoted chain in chronological order", async () => {
  const result = await buildFeishuTriggerInput(
    { ...baseInbound, parentMessageId: "newer-quote" },
    {
      fetchMessage: async (messageId) => {
        if (messageId === "newer-quote") {
          return {
            messageId,
            messageType: "text",
            senderType: "app",
            senderId: "bot",
            content: JSON.stringify({ text: "newer answer" }),
            parentMessageId: "oldest-quote",
          };
        }
        return {
          messageId,
          messageType: "text",
          senderType: "user",
          senderId: "sender",
          content: JSON.stringify({ text: "oldest question" }),
        };
      },
      listThreadMessages: unusedList,
    },
  );

  assert.deepEqual(result.quotedMessages, [
    {
      messageId: "oldest-quote",
      messageType: "text",
      senderType: "user",
      senderId: "sender",
      content: { text: "oldest question" },
    },
    {
      messageId: "newer-quote",
      messageType: "text",
      senderType: "app",
      senderId: "bot",
      content: { text: "newer answer" },
    },
  ]);
  assert.deepEqual(result.threadMessages, []);
});

test("fetches full topic history when thread_id is present", async () => {
  const listed: string[] = [];
  const result = await buildFeishuTriggerInput(
    {
      ...baseInbound,
      chatType: "group",
      parentMessageId: "topic-root",
      rootMessageId: "topic-root",
      threadId: "omt_topic",
      content: JSON.stringify({ text: "@_user_1 adjust threshold" }),
    },
    {
      fetchMessage: async (messageId) => {
        assert.equal(messageId, "topic-root");
        return {
          messageId: "topic-root",
          messageType: "interactive",
          senderType: "app",
          senderId: "bot",
          content: JSON.stringify({ title: "alert card" }),
          threadId: "omt_topic",
        };
      },
      listThreadMessages: async (threadId) => {
        listed.push(threadId);
        return [
          {
            messageId: "topic-root",
            messageType: "interactive",
            senderType: "app",
            senderId: "bot",
            content: JSON.stringify({ title: "alert card" }),
            threadId,
          },
          {
            messageId: "prior-user",
            messageType: "text",
            senderType: "user",
            senderId: "sender",
            content: JSON.stringify({ text: "exclude 4xx" }),
            parentMessageId: "topic-root",
            rootMessageId: "topic-root",
            threadId,
          },
          {
            messageId: "prior-bot",
            messageType: "text",
            senderType: "app",
            senderId: "bot",
            content: JSON.stringify({ text: "proposal sent" }),
            parentMessageId: "topic-root",
            rootMessageId: "topic-root",
            threadId,
          },
          {
            messageId: "current-message",
            messageType: "text",
            senderType: "user",
            senderId: "sender",
            content: JSON.stringify({ text: "@_user_1 adjust threshold" }),
            parentMessageId: "topic-root",
            rootMessageId: "topic-root",
            threadId,
          },
        ];
      },
    },
  );

  assert.deepEqual(listed, ["omt_topic"]);
  assert.deepEqual(result.quotedMessages, [
    {
      messageId: "topic-root",
      messageType: "interactive",
      senderType: "app",
      senderId: "bot",
      content: { title: "alert card" },
    },
  ]);
  assert.deepEqual(result.threadMessages, [
    {
      messageId: "topic-root",
      messageType: "interactive",
      senderType: "app",
      senderId: "bot",
      content: { title: "alert card" },
    },
    {
      messageId: "prior-user",
      messageType: "text",
      senderType: "user",
      senderId: "sender",
      content: { text: "exclude 4xx" },
    },
    {
      messageId: "prior-bot",
      messageType: "text",
      senderType: "app",
      senderId: "bot",
      content: { text: "proposal sent" },
    },
  ]);
});

test("resolves thread_id from the quoted parent when the event omits it", async () => {
  const result = await buildFeishuTriggerInput(
    {
      ...baseInbound,
      parentMessageId: "topic-root",
      content: JSON.stringify({ text: "@_user_1 again" }),
    },
    {
      fetchMessage: async (messageId) => ({
        messageId,
        messageType: "text",
        senderType: "app",
        senderId: "bot",
        content: JSON.stringify({ text: "root" }),
        threadId: "omt_from_parent",
      }),
      listThreadMessages: async (threadId) => {
        assert.equal(threadId, "omt_from_parent");
        return [
          {
            messageId: "topic-root",
            messageType: "text",
            senderType: "app",
            senderId: "bot",
            content: JSON.stringify({ text: "root" }),
            threadId,
          },
          {
            messageId: "earlier",
            messageType: "text",
            senderType: "user",
            senderId: "sender",
            content: JSON.stringify({ text: "earlier note" }),
            threadId,
          },
        ];
      },
    },
  );

  assert.equal(result.threadMessages.length, 2);
  assert.deepEqual(result.threadMessages[1]?.content, {
    text: "earlier note",
  });
});

test("fails when required quoted context cannot be fetched", async () => {
  await assert.rejects(
    buildFeishuTriggerInput(
      { ...baseInbound, parentMessageId: "missing-message" },
      {
        fetchMessage: async () => {
          throw new Error("not found");
        },
        listThreadMessages: unusedList,
      },
    ),
    /not found/,
  );
});

test("fails when thread history cannot be listed", async () => {
  await assert.rejects(
    buildFeishuTriggerInput(
      { ...baseInbound, threadId: "omt_missing" },
      {
        fetchMessage: async () => {
          throw new Error("unused");
        },
        listThreadMessages: async () => {
          throw new Error("thread list denied");
        },
      },
    ),
    /thread list denied/,
  );
});

test("fails on a cycle in the quoted chain", async () => {
  await assert.rejects(
    buildFeishuTriggerInput(
      { ...baseInbound, parentMessageId: "quoted-message" },
      {
        fetchMessage: async () => ({
          messageId: "quoted-message",
          messageType: "text",
          senderType: "app",
          content: JSON.stringify({ text: "loop" }),
          parentMessageId: "current-message",
        }),
        listThreadMessages: unusedList,
      },
    ),
    /contains a cycle/,
  );
});
