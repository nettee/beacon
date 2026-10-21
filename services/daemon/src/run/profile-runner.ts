import { type Profile, selectProfileModel } from "../config/profile.js";
import type { FinalOutcomeContent } from "../domain/types.js";
import type {
  FeishuTriggerInput,
  MessageSnapshot,
} from "../feishu/trigger-input.js";
import type { OutcomeSink } from "../outcome/server.js";
import {
  type PiRunRequest,
  type PiRunResult,
  runPiAgent,
} from "../runtime/pi-rpc.js";
import {
  ensureProfileWorkspace,
  workspaceSkills,
} from "../runtime/profile-workspace.js";
import { buildAgentSystemPrompt } from "../runtime/system-prompt.js";

export type RunProfile = (
  trigger: FeishuTriggerInput,
) => Promise<FinalOutcomeContent>;

export type AgentRuntimeRunner = (
  request: PiRunRequest,
) => Promise<PiRunResult>;

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
    "thread_messages is the full Feishu topic/thread history in chronological order (oldest first), excluding current_message. Empty when the trigger is not inside a topic.",
    "current_message is the message that triggered this Run.",
    JSON.stringify(
      {
        chat_type: trigger.source.chatType,
        quoted_messages: trigger.quotedMessages.map(messageForPrompt),
        thread_messages: trigger.threadMessages.map(messageForPrompt),
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
  options: { profileWorkspaceEnabled?: boolean | undefined } = {},
): RunProfile {
  return async (trigger) => {
    const submission = outcomes.openRun();
    const choice = selectProfileModel(profile);
    const workspaceEnabled = options.profileWorkspaceEnabled === true;
    let cwd = profile.playbook;
    let skills = profile.skills;
    let workspace: string | undefined;
    if (workspaceEnabled) {
      const ensured = await ensureProfileWorkspace(profile);
      cwd = ensured.directory;
      skills = workspaceSkills(profile, ensured);
      workspace = ensured.directory;
    }
    await runAgent({
      prompt: formatFeishuTriggerPrompt(trigger),
      playbook: profile.playbook,
      cwd,
      provider: choice.provider,
      model: choice.id,
      ...(choice.thinking ? { thinkingLevel: choice.thinking } : {}),
      systemPrompt: buildAgentSystemPrompt(
        profile,
        {
          kind: "feishu_message",
          notify: false,
        },
        workspace ? { workspace } : {},
      ),
      outcome: { ...submission.binding, cliPath: beaconCliPath },
      ...(skills ? { skills } : {}),
    });
    return submission.take();
  };
}
