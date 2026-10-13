import { join } from "node:path";

import type { GlobalConfig } from "../config/global.js";
import type { Profile } from "../config/profile.js";
import type { OutcomeServer } from "../outcome/server.js";
import { runPiAgent } from "../runtime/pi-rpc.js";
import { DEFAULT_ORPHAN_AFTER_MS } from "../runtime/supervisor-lease.js";
import type { TriggerStore } from "../state/trigger-store.js";
import { type DeliveryAdapter, RunOrchestrator } from "./orchestrator.js";
import type { RunQueue } from "./queue.js";

export type PiOrchestratorConfig = Pick<GlobalConfig, "pi" | "runs"> & {
  homeDirectory: string;
};

export function createPiRunOrchestrator(options: {
  beaconCliPath: string;
  config: PiOrchestratorConfig;
  runtimeEnvironment: NodeJS.ProcessEnv;
  profile: Profile;
  store: TriggerStore;
  queue: RunQueue;
  outcomes: OutcomeServer;
  delivery: DeliveryAdapter;
  /** Override for tests; production always detaches. */
  detachRuns?: boolean | undefined;
  orphanAfterMs?: number | undefined;
}): RunOrchestrator {
  const detachRuns = options.detachRuns ?? true;
  const stateDirectory = join(options.config.homeDirectory, "state");
  const supervisorLeasePath = join(stateDirectory, "supervisor.lease");
  const outcomesDirectory = join(stateDirectory, "outcomes");
  return new RunOrchestrator({
    profile: options.profile,
    store: options.store,
    queue: options.queue,
    outcomes: options.outcomes,
    beaconCliPath: options.beaconCliPath,
    sessionDirectory: options.config.pi.sessionDirectory,
    runAgent: (request) =>
      runPiAgent(request, {
        executable: options.config.pi.executable,
        timeoutMs: options.config.runs.timeoutSeconds * 1_000,
        terminateGraceMs: options.config.runs.terminateGraceSeconds * 1_000,
        environment: {
          PI_CODING_AGENT_DIR: options.config.pi.codingAgentDirectory,
        },
        runtimeEnvironment: options.runtimeEnvironment,
      }),
    delivery: options.delivery,
    ...(detachRuns
      ? {
          detached: {
            supervisorLeasePath,
            outcomesDirectory,
            orphanAfterMs: options.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS,
            executable: options.config.pi.executable,
            timeoutMs: options.config.runs.timeoutSeconds * 1_000,
            terminateGraceMs: options.config.runs.terminateGraceSeconds * 1_000,
            environment: {
              PI_CODING_AGENT_DIR: options.config.pi.codingAgentDirectory,
            },
            runtimeEnvironment: options.runtimeEnvironment,
          },
        }
      : {}),
  });
}
