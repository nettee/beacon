import { createHash } from "node:crypto";

import type { Profile } from "../config/profile.js";
import type { DeliveryTarget, TriggerInput } from "../domain/types.js";
import {
  feedbackContractInstructions,
  finalOutcomeContractInstructions,
} from "../outcome/instructions.js";

export type AgentSystemPromptTrigger = {
  kind: TriggerInput["kind"];
  scheduleId?: string | undefined;
  notify: boolean;
};

export function agentSystemPromptTrigger(
  input: TriggerInput | undefined,
  notifyTarget: DeliveryTarget | undefined,
): AgentSystemPromptTrigger {
  const notify = notifyTarget !== undefined;
  if (input?.kind === "schedule") {
    return { kind: "schedule", scheduleId: input.scheduleId, notify };
  }
  if (input?.kind === "feishu_message") {
    return { kind: "feishu_message", notify: false };
  }
  return { kind: "manual", notify };
}

export function profilePromptDigest(
  profile: Pick<Profile, "persona" | "task">,
): string {
  return createHash("sha256")
    .update(profile.persona)
    .update("\n")
    .update(profile.task)
    .digest("hex");
}

export function buildAgentSystemPrompt(
  profile: Pick<Profile, "persona" | "task" | "workspace">,
  trigger: AgentSystemPromptTrigger,
): string {
  return [
    `All local file reads, searches, and modifications must stay within the workspace directory and its descendants: ${profile.workspace}`,
    "",
    ...thisRunCapabilityInstructions(trigger),
    "",
    ...finalOutcomeContractInstructions,
    "",
    ...feedbackContractInstructions,
    "",
    profile.persona,
    "",
    profile.task,
  ].join("\n");
}

function thisRunCapabilityInstructions(
  trigger: AgentSystemPromptTrigger,
): string[] {
  if (trigger.kind === "feishu_message") {
    return [
      "This Run is an inbound Feishu message.",
      "Close the conversational channel with exactly one of `reply` or `reply_card`.",
      "Use text `reply` for ordinary answers and out-of-role messages.",
      "Use `reply_card` when the user-facing result should be a structured Feishu card.",
      "Do not call `no_reply`. Do not call `notify_card`.",
    ];
  }

  const notifyLine = trigger.notify
    ? "You may also call `notify_card` at most once."
    : "Do not call `notify_card`.";

  if (trigger.kind === "schedule") {
    const label = trigger.scheduleId
      ? `This Run is Schedule ${trigger.scheduleId}.`
      : "This Run is a Schedule.";
    return [
      label,
      "Close the conversational channel with exactly one of `reply` or `no_reply`.",
      "Do not call `reply_card`.",
      notifyLine,
    ];
  }

  return [
    "This Run is a manual operator trigger.",
    "Close the conversational channel with exactly one of `reply` or `no_reply`.",
    "Do not call `reply_card`.",
    notifyLine,
  ];
}
