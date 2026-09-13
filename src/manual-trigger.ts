import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadGlobalConfig } from "./config/global.js";
import { loadProfileRegistry } from "./config/registry.js";
import type { DeliveryAdapter } from "./run/orchestrator.js";
import { RunOrchestrator } from "./run/orchestrator.js";
import { RunQueue } from "./run/queue.js";
import { runPiAgent } from "./runtime/pi-rpc.js";
import { startOutcomeServer } from "./outcome/server.js";
import { TriggerStore } from "./state/trigger-store.js";

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

export async function runManualTrigger(
  configPath: string,
  profileId: string,
  input: string,
  output: (text: string) => Promise<void> = writeStdout,
): Promise<void> {
  if (!input.trim()) throw new Error("Manual Trigger input must not be empty");
  const global = await loadGlobalConfig(configPath);
  const profiles = await loadProfileRegistry(global.profilesDirectory);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown Profile: ${profileId}`);
  const outcomes = await startOutcomeServer();
  try {
    const store = new TriggerStore(profile.directory, profile.id);
    const claim = await store.claim({
      sourceKey: ["manual", randomUUID()],
      target: { kind: "local_stdout" },
      ingress: { text: input },
    });
    const delivery: DeliveryAdapter = {
      async deliver(target, text) {
        if (target.kind !== "local_stdout") {
          throw new Error("Manual Trigger requires local stdout Delivery");
        }
        await output(text);
        return {};
      },
    };
    const orchestrator = new RunOrchestrator({
      profile,
      store,
      queue: new RunQueue(global.runs.maxConcurrent, global.runs.maxQueued),
      outcomes,
      beaconCliPath: fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      runAgent: (request) =>
        runPiAgent(request, {
          executable: global.pi.executable,
          timeoutMs: global.runs.timeoutSeconds * 1_000,
          terminateGraceMs: global.runs.terminateGraceSeconds * 1_000,
          environment: { PI_CODING_AGENT_DIR: global.pi.codingAgentDirectory },
        }),
      delivery,
    });
    await orchestrator.process(claim.record.triggerKey, async () => ({
      kind: "manual",
      text: input,
    }));
    const record = (await store.list()).find(
      (candidate) => candidate.triggerKey === claim.record.triggerKey,
    );
    if (record?.run?.state !== "succeeded" || record.delivery?.state !== "delivered") {
      throw new Error(`Manual Trigger failed: ${record?.run?.failure?.code ?? record?.delivery?.failure?.code ?? "unknown"}`);
    }
  } finally {
    await outcomes.close();
  }
}
