import {
  defaultChannelsPath,
  loadChannelRegistry,
} from "../config/channels.js";
import { loadProfile } from "../config/profile.js";
import type { FeishuTriggerInput } from "../feishu/trigger-input.js";
import { createProfileRunner } from "../run/profile-runner.js";
import type { RuntimeOptions } from "../runtime-options.js";
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

export async function runOutcomeDoctor(
  profileId: string,
  options: RuntimeOptions,
): Promise<void> {
  const channelsPath = defaultChannelsPath();
  const channels = await loadChannelRegistry(channelsPath);
  const profile = await loadProfile(profileId, undefined, {
    channels,
    channelsPath,
  });
  const outcomes = await startOutcomeServer();
  const beaconCliPath = options.beaconCliPath;
  try {
    const result = await createProfileRunner(
      profile,
      outcomes,
      beaconCliPath,
    )(doctorTrigger);
    if (
      result.reply.kind !== "text" ||
      result.reply.text.trim() !== "OUTCOME_CLI_OK"
    ) {
      throw new Error(
        `Outcome doctor received unexpected submitted text: ${JSON.stringify(result)}`,
      );
    }
    console.log("[beacon] explicit Final Outcome chain ready");
  } finally {
    await outcomes.close();
  }
}
