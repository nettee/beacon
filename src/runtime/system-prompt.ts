import type { Profile } from "../config/profile.js";
import { finalOutcomeSystemInstructions } from "../outcome/instructions.js";

export function buildAgentSystemPrompt(
  profile: Pick<Profile, "prompt" | "workspace">,
): string {
  return [
    profile.prompt,
    "",
    `All local file reads, searches, and modifications must stay within the workspace directory and its descendants: ${profile.workspace}`,
    "",
    ...finalOutcomeSystemInstructions,
  ].join("\n");
}
