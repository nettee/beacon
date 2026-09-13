import { fileURLToPath } from "node:url";

import type { GlobalConfig } from "../config/global.js";
import type { Profile } from "../config/profile.js";
import type { OutcomeServer } from "../outcome/server.js";
import { runPiAgent } from "../runtime/pi-rpc.js";
import type { TriggerStore } from "../state/trigger-store.js";
import { type DeliveryAdapter, RunOrchestrator } from "./orchestrator.js";
import type { RunQueue } from "./queue.js";

export type PiOrchestratorConfig = Pick<GlobalConfig, "pi" | "runs">;

export function createPiRunOrchestrator(options: {
  config: PiOrchestratorConfig;
  profile: Profile;
  store: TriggerStore;
  queue: RunQueue;
  outcomes: OutcomeServer;
  delivery: DeliveryAdapter;
}): RunOrchestrator {
  return new RunOrchestrator({
    profile: options.profile,
    store: options.store,
    queue: options.queue,
    outcomes: options.outcomes,
    beaconCliPath: fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
    runAgent: (request) =>
      runPiAgent(request, {
        executable: options.config.pi.executable,
        timeoutMs: options.config.runs.timeoutSeconds * 1_000,
        terminateGraceMs: options.config.runs.terminateGraceSeconds * 1_000,
        environment: {
          PI_CODING_AGENT_DIR: options.config.pi.codingAgentDirectory,
        },
      }),
    delivery: options.delivery,
  });
}
