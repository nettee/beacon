import { runPiAgent } from "./pi-rpc.js";

export async function runPiDoctor(
  provider?: string,
  model?: string,
): Promise<void> {
  const result = await runPiAgent({
    prompt: "Reply with exactly: BEACON_PI_RPC_OK",
    workspace: process.cwd(),
    provider,
    model,
    systemPrompt: "Follow the user's instruction exactly. Do not use tools.",
  });

  if (result.text !== "BEACON_PI_RPC_OK") {
    throw new Error(
      `Pi RPC smoke test returned an unexpected response: ${JSON.stringify(result.text)}`,
    );
  }
  console.log(
    `[beacon] Pi RPC ready provider=${result.provider} model=${result.model}`,
  );
}
