import { join } from "node:path";
import { loadEventCredentials } from "./config/event-credentials.js";
import { loadGlobalConfig } from "./config/global.js";
import { loadProfileRegistry } from "./config/registry.js";
import { loadRuntimeEnvironment } from "./config/runtime-environment.js";
import { loadFeishuCredentials } from "./config/secrets.js";
import { type DashboardServer, startDashboard } from "./dashboard/server.js";
import { EventPipeline } from "./events/pipeline.js";
import { startEventServer } from "./events/server.js";
import { EventStore } from "./events/store.js";
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

  const eventProducers = global.events
    ? await loadEventCredentials(global.events.credentialsPath)
    : [];
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[beacon] dashboard failed to listen http://${global.dashboard.listen}:${String(global.dashboard.port)}: ${message}; continuing without dashboard`,
    );
  }
  const shutdown = shutdownController();
  let firstFatal: Error | undefined;
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<Error>((resolve) => {
    rejectFatal = (error) => {
      firstFatal ??= error;
      resolve(error);
    };
  });
  let eventServer: Awaited<ReturnType<typeof startEventServer>> | undefined;
  let eventPipeline: EventPipeline | undefined;
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
    return { profile, store, messagePipeline, orchestrator, reconciler };
  });

  let gateways: Promise<void>[] = [];
  const failures: unknown[] = [];
  try {
    await Promise.all(
      contexts.map((context) => context.orchestrator.recover()),
    );
    const reconciliationTime = new Date();
    await Promise.all(
      contexts.map((context) =>
        context.reconciler.reconcile(reconciliationTime),
      ),
    );
    if (global.events) {
      const store = new EventStore(
        join(global.homeDirectory, "state", "events"),
      );
      eventPipeline = new EventPipeline({
        store,
        contexts,
        maxPending: global.events.maxPending,
        onFatal: rejectFatal,
      });
      eventServer = await startEventServer({
        ...global.events,
        producers: eventProducers,
        pipeline: eventPipeline,
        store,
        onFatal: rejectFatal,
      });
      eventPipeline.wake();
      console.log(
        `[beacon] events listening http://${global.events.listen}:${eventServer.port} (authenticated)`,
      );
    }
    for (const loop of loops) loop.start(reconciliationTime);
    gateways = contexts.map(({ profile, messagePipeline }) => {
      console.log(
        `[beacon] starting Profile id=${profile.id} runtime=${profile.runtime} provider=${profile.model.provider} model=${profile.model.id}`,
      );
      return messagePipeline.run(shutdown.promise);
    });
    const result = await Promise.race([shutdown.promise, fatal, ...gateways]);
    if (result instanceof Error) throw result;
  } catch (error) {
    failures.push(error);
  } finally {
    shutdown.resolve();
    for (const loop of loops) loop.stop();
    // Stop HTTP intake, finish current event execution, leave the rest durable.
    const stoppedEvents = await Promise.allSettled([
      eventServer?.close() ?? Promise.resolve(),
      eventPipeline?.close() ?? Promise.resolve(),
    ]);
    await Promise.allSettled(gateways);
    const drained = await Promise.allSettled([
      ...messagePipelines.map((pipeline) => pipeline.drain()),
      ...loops.map((loop) => loop.drain()),
    ]);
    shutdown.close();
    const closed = await Promise.allSettled([
      dashboard?.close() ?? Promise.resolve(),
      outcomes.close(),
    ]);
    for (const result of [...stoppedEvents, ...drained, ...closed]) {
      if (result.status === "rejected" && !failures.includes(result.reason))
        failures.push(result.reason);
    }
  }
  if (firstFatal && !failures.includes(firstFatal)) failures.push(firstFatal);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Beacon service failed");
}
