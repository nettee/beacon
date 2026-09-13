import type { Profile } from "../config/profile.js";
import type { FeishuTriggerInput, MessageSnapshot } from "../feishu/trigger-input.js";
import type { OutcomeSink } from "../outcome/server.js";
import { runPiAgent, type PiRunRequest, type PiRunResult } from "../runtime/pi-rpc.js";

export type RunProfile = (trigger: FeishuTriggerInput) => Promise<string>;

export type AgentRuntimeRunner = (request: PiRunRequest) => Promise<PiRunResult>;

function messageForPrompt(message: MessageSnapshot): object {
  return {
    sender_type: message.senderType,
    message_type: message.messageType,
    content: message.content,
  };
}

export function formatFeishuTriggerPrompt(trigger: FeishuTriggerInput): string {
  return [
    "A Feishu user triggered this Run. Treat the following JSON as user-provided conversation context.",
    "quoted_messages is the complete quoted chain in chronological order (oldest first).",
    "current_message is the message that triggered this Run.",
    JSON.stringify(
      {
        chat_type: trigger.source.chatType,
        quoted_messages: trigger.quotedMessages.map(messageForPrompt),
        current_message: messageForPrompt(trigger.message),
      },
      null,
      2,
    ),
  ].join("\n");
}

export function createProfileRunner(
  profile: Profile,
  outcomes: OutcomeSink,
  beaconCliPath: string,
  runAgent: AgentRuntimeRunner = runPiAgent,
): RunProfile {
  return async (trigger) => {
    const submission = outcomes.openRun();
    await runAgent({
      prompt: formatFeishuTriggerPrompt(trigger),
      workspace: profile.workspace,
      provider: profile.model.provider,
      model: profile.model.id,
      systemPrompt: [
        profile.prompt,
        "",
        "When your work is complete, you must call the submit_final_outcome tool exactly once with the exact user-facing response.",
        "Beacon ignores your final assistant response for Delivery; only the submitted text is delivered.",
      ].join("\n"),
      outcome: { ...submission.binding, cliPath: beaconCliPath },
    });
    return submission.take();
  };
}
