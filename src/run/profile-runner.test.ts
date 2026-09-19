import assert from "node:assert/strict";
import test from "node:test";

import type { Profile } from "../config/profile.js";
import type { FeishuTriggerInput } from "../feishu/trigger-input.js";
import { createProfileRunner } from "./profile-runner.js";

const profile: Profile = {
  id: "test-profile",
  directory: "/profiles/test-profile",
  prompt: "You are the configured persona.",
  workspace: "/workspace",
  runtime: "pi",
  model: { provider: "openrouter", id: "test/model" },
  schedules: [],
};

const trigger: FeishuTriggerInput = {
  source: {
    messageId: "current",
    chatId: "chat",
    chatType: "p2p",
    senderId: "user",
  },
  quotedMessages: [
    {
      messageId: "old",
      senderType: "user",
      senderId: "user",
      messageType: "text",
      content: { text: "original question" },
    },
    {
      messageId: "answer",
      senderType: "app",
      senderId: "bot",
      messageType: "text",
      content: { text: "previous answer" },
    },
  ],
  message: {
    messageId: "current",
    senderType: "user",
    senderId: "user",
    messageType: "text",
    content: { text: "follow up" },
  },
};

test("maps a Profile and the complete quoted chain to one fresh Agent Run", async () => {
  let captured: unknown;
  const run = createProfileRunner(
    profile,
    {
      openRun: () => ({
        binding: { socketPath: "/tmp/beacon.sock", runToken: "run-token" },
        take: () => ({
          kind: "text" as const,
          text: "submitted final outcome",
        }),
        cancel: () => undefined,
      }),
    },
    "/beacon/dist/cli.js",
    async (request) => {
      captured = request;
      return {
        text: "ignored assistant response",
        provider: "openrouter",
        model: "test/model",
      };
    },
  );

  assert.deepEqual(await run(trigger), {
    kind: "text",
    text: "submitted final outcome",
  });
  assert.deepEqual(captured, {
    prompt: [
      "A Feishu user triggered this Run. Treat the following JSON as user-provided conversation context.",
      "quoted_messages is the complete quoted chain in chronological order (oldest first).",
      "current_message is the message that triggered this Run.",
      JSON.stringify(
        {
          chat_type: "p2p",
          quoted_messages: [
            {
              sender_type: "user",
              message_type: "text",
              content: { text: "original question" },
            },
            {
              sender_type: "app",
              message_type: "text",
              content: { text: "previous answer" },
            },
          ],
          current_message: {
            sender_type: "user",
            message_type: "text",
            content: { text: "follow up" },
          },
        },
        null,
        2,
      ),
    ].join("\n"),
    workspace: "/workspace",
    provider: "openrouter",
    model: "test/model",
    systemPrompt: [
      "You are the configured persona.",
      "",
      "All local file reads, searches, and modifications must stay within the workspace directory and its descendants: /workspace",
      "",
      "When your work is complete, call exactly one of submit_final_outcome_text, submit_final_outcome_card, or submit_final_outcome_no_reply.",
      "Use submit_final_outcome_text for a normal response, submit_final_outcome_card when a titled Markdown summary and link buttons materially improve the result, or submit_final_outcome_no_reply when the triggering message is outside the Profile's role and should receive no response.",
      "Beacon ignores ordinary assistant final text for Delivery.",
    ].join("\n"),
    outcome: {
      socketPath: "/tmp/beacon.sock",
      runToken: "run-token",
      cliPath: "/beacon/dist/cli.js",
    },
  });
});
