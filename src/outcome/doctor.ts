import { fileURLToPath } from "node:url";

import { loadProfile } from "../config/profile.js";
import type { FeishuTriggerInput } from "../feishu/trigger-input.js";
import { createProfileRunner } from "../run/profile-runner.js";
import { startOutcomeServer } from "./server.js";

const doctorTrigger: FeishuTriggerInput = {
  source: { messageId: "doctor", chatId: "doctor", chatType: "p2p" },
  quotedMessages: [],
  message: {
    messageId: "doctor",
    senderType: "user",
    messageType: "text",
    content: { text: "Return exactly OUTCOME_CLI_OK." },
  },
};

export async function runOutcomeDoctor(profileId: string): Promise<void> {
  const profile = await loadProfile(profileId);
  const outcomes = await startOutcomeServer();
  const beaconCliPath = fileURLToPath(
    new URL("../../dist/cli.js", import.meta.url),
  );
  try {
    const result = await createProfileRunner(
      profile,
      outcomes,
      beaconCliPath,
    )(doctorTrigger);
    if (result.trim() !== "OUTCOME_CLI_OK") {
      throw new Error(
        `Outcome doctor received unexpected submitted text: ${JSON.stringify(result)}`,
      );
    }
    console.log("[beacon] explicit Final Outcome chain ready");
  } finally {
    await outcomes.close();
  }
}
