import { loadGlobalConfig } from "./config/global.js";
import { loadProfileRegistry } from "./config/registry.js";
import { loadRuntimeEnvironment } from "./config/runtime-environment.js";
import { loadFeishuCredentials } from "./config/secrets.js";
import { type DashboardServer, startDashboard } from "./dashboard/server.js";
import { createFeishuGateway } from "./feishu/gateway.js";
import { createFeishuMessagePipeline } from "./feishu/message-pipeline.js";
import { startOutcomeServer } from "./outcome/server.js";
import { createPiRunOrchestrator } from "./run/create-pi-orchestrator.js";
import { RunQueue } from "./run/queue.js";
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
  const runtimeEnvironment = await loadRuntimeEnvironment(
    global.runtimeEnvironmentPath,
  );
  const profiles = await loadProfileRegistry(global.profilesDirectory);
  const credentials = await Promise.all(
    profiles.map((profile) =>
      loadFeishuCredentials(profile.id, global.secretsPath),
    ),
  );

  const outcomes = await startOutcomeServer();
  const queue = new RunQueue(global.runs.maxConcurrent, global.runs.maxQueued);
  let dashboard: DashboardServer | undefined;
  try {
    if (global.dashboard.enabled) {
      dashboard = await startDashboard({
        listen: global.dashboard.listen,
        port: global.dashboard.port,
        profilesDirectory: global.profilesDirectory,
        sessionDirectory: global.pi.sessionDirectory,
        piExecutable: global.pi.executable,
      });
      console.log(
        `[beacon] dashboard listening http://${global.dashboard.listen}:${dashboard.port} (unauthenticated)`,
      );
    }
  } catch (error) {
    await outcomes.close();
    throw error;
  }
  const shutdown = shutdownController();
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  const messagePipelines: ReturnType<typeof createFeishuMessagePipeline>[] = [];
  const loops: ScheduleLoop[] = [];
  const contexts = profiles.map((profile, index) => {
    const profileCredentials = credentials[index]!;
    const gateway = createFeishuGateway(profileCredentials);
    const store = new TriggerStore(profile.directory, profile.id);
    const orchestrator = createPiRunOrchestrator({
      config: global,
      runtimeEnvironment,
      profile,
      store,
      queue,
      outcomes,
      delivery: gateway,
    });
    const messagePipeline = createFeishuMessagePipeline({
      gateway,
      store,
      process: (triggerKey, normalize) =>
        orchestrator.process(triggerKey, normalize),
      onFatal: rejectFatal,
    });
    messagePipelines.push(messagePipeline);
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
    return { profile, messagePipeline, orchestrator, reconciler };
  });

  await Promise.all(contexts.map((context) => context.orchestrator.recover()));
  const reconciliationTime = new Date();
  await Promise.all(
    contexts.map((context) => context.reconciler.reconcile(reconciliationTime)),
  );
  for (const loop of loops) loop.start(reconciliationTime);

  const gateways = contexts.map(({ profile, messagePipeline }) => {
    console.log(
      `[beacon] starting Profile id=${profile.id} runtime=${profile.runtime} provider=${profile.model.provider} model=${profile.model.id}`,
    );
    return messagePipeline.run(shutdown.promise);
  });

  try {
    await Promise.race([shutdown.promise, fatal, ...gateways]);
  } finally {
    shutdown.resolve();
    for (const loop of loops) loop.stop();
    await Promise.allSettled(gateways);
    await Promise.allSettled([
      ...messagePipelines.map((pipeline) => pipeline.drain()),
      ...loops.map((loop) => loop.drain()),
    ]);
    shutdown.close();
    await Promise.allSettled([
      dashboard?.close() ?? Promise.resolve(),
      outcomes.close(),
    ]);
  }
}
