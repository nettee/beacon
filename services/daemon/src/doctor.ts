import { loadChannelRegistry } from "./config/channels.js";
import { loadEventCredentials } from "./config/event-credentials.js";
import { loadGlobalConfig } from "./config/global.js";
import { loadProfileRegistry } from "./config/registry.js";
import { loadRuntimeEnvironment } from "./config/runtime-environment.js";
import {
  feishuWsListenerProfileIds,
  resolveFeishuCredentialBindings,
} from "./config/secrets.js";
import { createFeishuGateway } from "./feishu/gateway.js";
import { profileLimitsFromProfiles } from "./run/queue.js";
import { runPiAgent } from "./runtime/pi-rpc.js";

export async function runDoctor(configPath: string): Promise<void> {
  const global = await loadGlobalConfig(configPath);
  const runtimeEnvironment = await loadRuntimeEnvironment(
    global.runtimeEnvironmentPath,
  );
  const channels = await loadChannelRegistry(global.channelsPath);
  const profiles = await loadProfileRegistry(
    global.profilesDirectory,
    channels,
    global.channelsPath,
  );
  // Fail fast if any Profile concurrency exceeds the host-wide ceiling.
  profileLimitsFromProfiles(profiles, global.runs);
  if (global.events) await loadEventCredentials(global.events.credentialsPath);
  const defaultFeishuProfileId = global.feishu?.defaultProfile;
  if (defaultFeishuProfileId) {
    if (!profiles.some((profile) => profile.id === defaultFeishuProfileId)) {
      throw new Error(
        `feishu.default_profile ${JSON.stringify(defaultFeishuProfileId)} does not match a loaded Profile`,
      );
    }
  }
  const bindings = await resolveFeishuCredentialBindings(
    profiles.map((profile) => profile.id),
    global.secretsPath,
    defaultFeishuProfileId
      ? { defaultProfileId: defaultFeishuProfileId }
      : undefined,
  );
  const wsListeners = feishuWsListenerProfileIds(bindings);
  const checkedAppIds = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    const binding = bindings[index]!;
    if (!checkedAppIds.has(binding.credentials.appId)) {
      await createFeishuGateway(binding.credentials).checkReady();
      checkedAppIds.add(binding.credentials.appId);
    }
    const result = await runPiAgent(
      {
        prompt: "Reply with exactly: BEACON_PI_RPC_OK",
        playbook: profile.playbook,
        provider: profile.model.provider,
        model: profile.model.id,
        systemPrompt:
          "Follow the user's instruction exactly. Do not use tools.",
      },
      {
        executable: global.pi.executable,
        timeoutMs: global.runs.timeoutSeconds * 1_000,
        terminateGraceMs: global.runs.terminateGraceSeconds * 1_000,
        environment: { PI_CODING_AGENT_DIR: global.pi.codingAgentDirectory },
        runtimeEnvironment,
      },
    );
    if (result.text !== "BEACON_PI_RPC_OK") {
      throw new Error(
        `Pi readiness returned unexpected text for Profile ${profile.id}: ${JSON.stringify(result.text)}`,
      );
    }
    if (wsListeners.has(profile.id)) {
      console.log(
        `[beacon] doctor Profile ready id=${profile.id} feishu=dedicated ws_listener`,
      );
    } else {
      console.log(
        `[beacon] doctor Profile ready id=${profile.id} feishu=default via ${binding.sourceProfileId} outbound_only`,
      );
    }
  }
}
