import { fileURLToPath } from "node:url";

import { loadGlobalConfig } from "./config/global.js";
import { loadProfileRegistry } from "./config/registry.js";
import { loadFeishuCredentials } from "./config/secrets.js";
import { FeishuApi } from "./feishu/api.js";
import { runFeishuGateway } from "./feishu/gateway.js";
import { FeishuIntake } from "./feishu/intake.js";
import { startOutcomeServer } from "./outcome/server.js";
import { RunOrchestrator } from "./run/orchestrator.js";
import { RunQueue } from "./run/queue.js";
import { runPiAgent } from "./runtime/pi-rpc.js";
import { ScheduleCursorStore } from "./schedule/cursor-store.js";
import { ScheduleLoop } from "./schedule/loop.js";
import { ScheduleReconciler } from "./schedule/reconciler.js";
import { TriggerStore } from "./state/trigger-store.js";

type ShutdownController = {
  promise: Promise<void>;
  resolve(): void;
  close(): void;
};

function shutdownController(): ShutdownController {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  const stop = (): void => resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    promise,
    resolve,
    close() {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}

export async function runBeacon(configPath: string): Promise<void> {
  const global = await loadGlobalConfig(configPath);
  const profiles = await loadProfileRegistry(global.profilesDirectory);
  const credentials = await Promise.all(
    profiles.map((profile) =>
      loadFeishuCredentials(profile.id, global.secretsPath),
    ),
  );

  const outcomes = await startOutcomeServer();
  const queue = new RunQueue(global.runs.maxConcurrent, global.runs.maxQueued);
  const shutdown = shutdownController();
  const beaconCliPath = fileURLToPath(
    new URL("../dist/cli.js", import.meta.url),
  );
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  const intakes: FeishuIntake[] = [];
  const loops: ScheduleLoop[] = [];
  const contexts = profiles.map((profile, index) => {
    const profileCredentials = credentials[index]!;
    const api = new FeishuApi(profileCredentials);
    const store = new TriggerStore(profile.directory, profile.id);
    const orchestrator = new RunOrchestrator({
      profile,
      store,
      queue,
      outcomes,
      beaconCliPath,
      runAgent: (request) =>
        runPiAgent(request, {
          executable: global.pi.executable,
          timeoutMs: global.runs.timeoutSeconds * 1_000,
          terminateGraceMs: global.runs.terminateGraceSeconds * 1_000,
          environment: { PI_CODING_AGENT_DIR: global.pi.codingAgentDirectory },
        }),
      delivery: api,
    });
    const intake = new FeishuIntake({
      store,
      process: (triggerKey, normalize) =>
        orchestrator.process(triggerKey, normalize),
      fetchMessage: (messageId) => api.fetchMessage(messageId),
      acknowledge: (messageId) => api.acknowledge(messageId),
      onFatal: rejectFatal,
    });
    intakes.push(intake);
    const reconciler = new ScheduleReconciler({
      profile,
      triggers: store,
      cursors: new ScheduleCursorStore(profile.directory),
      maxOccurrences: global.scheduler.maxOccurrencesPerReconciliation,
      process: (triggerKey, normalize) =>
        orchestrator.process(triggerKey, normalize),
    });
    const loop = new ScheduleLoop(profile, reconciler, rejectFatal);
    loops.push(loop);
    return { profile, profileCredentials, intake, orchestrator, reconciler };
  });

  await Promise.all(contexts.map((context) => context.orchestrator.recover()));
  const reconciliationTime = new Date();
  await Promise.all(
    contexts.map((context) => context.reconciler.reconcile(reconciliationTime)),
  );
  for (const loop of loops) loop.start(reconciliationTime);

  const gateways = contexts.map(({ profile, profileCredentials, intake }) => {
    console.log(
      `[beacon] starting Profile id=${profile.id} runtime=${profile.runtime} provider=${profile.model.provider} model=${profile.model.id}`,
    );
    return runFeishuGateway(
      profileCredentials,
      (event) => intake.handle(event),
      shutdown.promise,
    );
  });

  try {
    await Promise.race([shutdown.promise, fatal, ...gateways]);
  } finally {
    shutdown.resolve();
    for (const loop of loops) loop.stop();
    await Promise.allSettled(gateways);
    await Promise.allSettled([
      ...intakes.map((intake) => intake.drain()),
      ...loops.map((loop) => loop.drain()),
    ]);
    shutdown.close();
    await outcomes.close();
  }
}
