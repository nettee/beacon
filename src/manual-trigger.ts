import { randomUUID } from "node:crypto";

import { loadGlobalConfig } from "./config/global.js";
import { loadProfileRegistry } from "./config/registry.js";
import { renderFinalOutcomeAsText } from "./outcome/content.js";
import { startOutcomeServer } from "./outcome/server.js";
import { createPiRunOrchestrator } from "./run/create-pi-orchestrator.js";
import type { DeliveryAdapter } from "./run/orchestrator.js";
import { RunQueue } from "./run/queue.js";
import { TriggerStore } from "./state/trigger-store.js";

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
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
      async deliver(target, outcome) {
        if (target.kind !== "local_stdout") {
          throw new Error("Manual Trigger requires local stdout Delivery");
        }
        await output(renderFinalOutcomeAsText(outcome));
        return {};
      },
    };
    const orchestrator = createPiRunOrchestrator({
      config: global,
      profile,
      store,
      queue: new RunQueue(global.runs.maxConcurrent, global.runs.maxQueued),
      outcomes,
      delivery,
    });
    await orchestrator.process(claim.record.triggerKey, async () => ({
      kind: "manual",
      text: input,
    }));
    const record = (await store.list()).find(
      (candidate) => candidate.triggerKey === claim.record.triggerKey,
    );
    if (
      record?.run?.state !== "succeeded" ||
      record.delivery?.state !== "delivered"
    ) {
      throw new Error(
        `Manual Trigger failed: ${record?.run?.failure?.code ?? record?.delivery?.failure?.code ?? "unknown"}`,
      );
    }
  } finally {
    await outcomes.close();
  }
}
