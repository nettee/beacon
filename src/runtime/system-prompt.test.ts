import assert from "node:assert/strict";
import test from "node:test";

import type { Profile } from "../config/profile.js";
import {
  feedbackContractInstructions,
  finalOutcomeContractInstructions,
} from "../outcome/instructions.js";
import {
  agentSystemPromptTrigger,
  buildAgentSystemPrompt,
  profilePromptDigest,
} from "./system-prompt.js";

const profile: Pick<Profile, "persona" | "task" | "workspace"> = {
  persona: "PERSONA_MARKER: identity and out-of-role judgment.",
  task: "TASK_MARKER: SOP order and when this Profile speaks.",
  workspace: "/workspace/example",
};

function promptFor(
  trigger: Parameters<typeof buildAgentSystemPrompt>[1],
): string {
  return buildAgentSystemPrompt(profile, trigger);
}

test("puts the English Beacon template before persona and task", () => {
  const prompt = promptFor({ kind: "feishu_message", notify: false });
  const workspaceAt = prompt.indexOf(
    "All local file reads, searches, and modifications must stay within the workspace directory and its descendants: /workspace/example",
  );
  const personaAt = prompt.indexOf(profile.persona);
  const taskAt = prompt.indexOf(profile.task);
  const contractAt = prompt.indexOf(finalOutcomeContractInstructions[0]);
  const feedbackAt = prompt.indexOf(feedbackContractInstructions[0]);
  assert.equal(workspaceAt, 0);
  assert.ok(workspaceAt < contractAt);
  assert.ok(contractAt < feedbackAt);
  assert.ok(feedbackAt < personaAt);
  assert.ok(personaAt < taskAt);
  assert.equal(prompt.trimEnd().endsWith(profile.task), true);
});

test("does not append an English Beacon tail after profile text", () => {
  const prompt = promptFor({ kind: "feishu_message", notify: false });
  const afterTask = prompt.slice(
    prompt.indexOf(profile.task) + profile.task.length,
  );
  assert.equal(afterTask.trim(), "");
  assert.doesNotMatch(
    afterTask,
    /All local file reads|This Run is|`reply` sends plain text|Beacon ignores ordinary assistant final text/,
  );
});

test("inbound Runs close with reply or reply_card", () => {
  const prompt = promptFor({ kind: "feishu_message", notify: false });
  assert.match(prompt, /This Run is an inbound Feishu message/);
  assert.match(prompt, /exactly one of `reply` or `reply_card`/);
  assert.match(prompt, /Do not call `no_reply`/);
  assert.match(prompt, /Do not call `notify_card`/);
  assert.doesNotMatch(prompt, /You may also call `notify_card`/);
});

test("Schedule Runs with notify may call notify_card once", () => {
  const prompt = promptFor({
    kind: "schedule",
    scheduleId: "hourly-detect-and-onboard-new-model",
    notify: true,
  });
  assert.match(
    prompt,
    /This Run is Schedule hourly-detect-and-onboard-new-model/,
  );
  assert.match(
    prompt,
    /Close the conversational channel with exactly one of `reply` or `no_reply`/,
  );
  assert.match(prompt, /You may also call `notify_card` at most once/);
  assert.doesNotMatch(prompt, /Do not call `notify_card`/);
});

test("Schedule Runs without notify do not grant notify_card", () => {
  const prompt = promptFor({
    kind: "schedule",
    scheduleId: "hourly-detect-and-onboard-new-model",
    notify: false,
  });
  assert.match(prompt, /Do not call `notify_card`/);
  assert.doesNotMatch(prompt, /You may also call `notify_card`/);
});

test("manual Runs close with reply or no_reply", () => {
  const prompt = promptFor({ kind: "manual", notify: false });
  assert.match(prompt, /This Run is a manual operator trigger/);
  assert.match(
    prompt,
    /Close the conversational channel with exactly one of `reply` or `no_reply`/,
  );
  assert.match(prompt, /Do not call `notify_card`/);
});

test("outcome contract tells the Agent not to fill chat_id", () => {
  const prompt = promptFor({ kind: "manual", notify: true });
  assert.match(prompt, /Do not fill `chat_id`/);
  assert.match(
    prompt,
    /Beacon ignores ordinary assistant final text for Delivery/,
  );
});

test("makes submit_feedback optional and forbids empty lists", () => {
  const prompt = promptFor({ kind: "manual", notify: false });
  assert.match(prompt, /you may call `submit_feedback` once/);
  assert.match(prompt, /If there are none, do not call it/);
  assert.doesNotMatch(prompt, /exactly once/);
  assert.doesNotMatch(prompt, /items: \[\]/);
});

test("hashes persona.md and task.md for promptDigest", () => {
  const digest = profilePromptDigest({
    persona: "persona",
    task: "task",
  });
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(
    digest,
    profilePromptDigest({ persona: "persona", task: "other" }),
  );
});

test("derives this-Run capabilities from trigger kind and notify target", () => {
  assert.deepEqual(
    agentSystemPromptTrigger(
      {
        kind: "feishu_message",
        eventId: "event",
        chatType: "p2p",
        quotedMessages: [],
        currentMessage: {
          messageId: "m",
          messageType: "text",
          senderType: "user",
          content: {},
        },
      },
      { kind: "chat", chatId: "ignored-for-inbound" },
    ),
    { kind: "feishu_message", notify: false },
  );
  assert.deepEqual(
    agentSystemPromptTrigger(
      {
        kind: "schedule",
        scheduleId: "daily",
        scheduledFor: "2026-09-22T02:00:00.000Z",
        text: "run",
      },
      { kind: "chat", chatId: "oc_group" },
    ),
    { kind: "schedule", scheduleId: "daily", notify: true },
  );
  assert.deepEqual(
    agentSystemPromptTrigger({ kind: "manual", text: "x" }, undefined),
    {
      kind: "manual",
      notify: false,
    },
  );
});
