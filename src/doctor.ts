import { loadGlobalConfig } from "./config/global.js";
import { loadProfileRegistry } from "./config/registry.js";
import { loadFeishuCredentials } from "./config/secrets.js";
import { createFeishuGateway } from "./feishu/gateway.js";
import { runPiAgent } from "./runtime/pi-rpc.js";

export async function runDoctor(configPath: string): Promise<void> {
  const global = await loadGlobalConfig(configPath);
  const profiles = await loadProfileRegistry(global.profilesDirectory);
  for (const profile of profiles) {
    const credentials = await loadFeishuCredentials(
      profile.id,
      global.secretsPath,
    );
    await createFeishuGateway(credentials).checkReady();
    const result = await runPiAgent(
      {
        prompt: "Reply with exactly: BEACON_PI_RPC_OK",
        workspace: profile.workspace,
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
      },
    );
    if (result.text !== "BEACON_PI_RPC_OK") {
      throw new Error(
        `Pi readiness returned unexpected text for Profile ${profile.id}: ${JSON.stringify(result.text)}`,
      );
    }
    console.log(`[beacon] doctor Profile ready id=${profile.id}`);
  }
}
