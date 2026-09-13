import assert from "node:assert/strict";
import test from "node:test";

import { buildFeishuTriggerInput } from "./trigger-input.js";

const baseInbound = {
  messageId: "current-message",
  chatId: "chat",
  chatType: "p2p",
  senderId: "sender",
  senderType: "user",
  messageType: "text",
  content: JSON.stringify({ text: "follow up" }),
};

test("normalizes a message without fetching quoted context", async () => {
  let fetched = false;
  const result = await buildFeishuTriggerInput(baseInbound, async () => {
    fetched = true;
    throw new Error("must not fetch");
  });

  assert.equal(fetched, false);
  assert.deepEqual(result.message.content, { text: "follow up" });
  assert.deepEqual(result.quotedMessages, []);
});

test("records the complete quoted chain in chronological order", async () => {
  const result = await buildFeishuTriggerInput(
    { ...baseInbound, parentMessageId: "newer-quote" },
    async (messageId) => {
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
});

test("fails when required quoted context cannot be fetched", async () => {
  await assert.rejects(
    buildFeishuTriggerInput(
      { ...baseInbound, parentMessageId: "missing-message" },
      async () => {
        throw new Error("not found");
      },
    ),
    /not found/,
  );
});

test("fails on a cycle in the quoted chain", async () => {
  await assert.rejects(
    buildFeishuTriggerInput(
      { ...baseInbound, parentMessageId: "quoted-message" },
      async () => ({
        messageId: "quoted-message",
        messageType: "text",
        senderType: "app",
        content: JSON.stringify({ text: "loop" }),
        parentMessageId: "current-message",
      }),
    ),
    /contains a cycle/,
  );
});
