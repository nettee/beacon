import { join } from "node:path";
import { loadChannelRegistry } from "./config/channels.js";
import { loadEventCredentials } from "./config/event-credentials.js";
import { loadGlobalConfig } from "./config/global.js";
import { loadProfile, patchProfileModelFields } from "./config/profile.js";
import { loadProfileRegistry } from "./config/registry.js";
import { loadRuntimeEnvironment } from "./config/runtime-environment.js";
import {
  feishuWsListenerProfileIds,
  resolveFeishuCredentialBindings,
} from "./config/secrets.js";
import { type DashboardServer, startDashboard } from "./dashboard/server.js";
import type { TriggerInput } from "./domain/types.js";
import { EventPipeline } from "./events/pipeline.js";
import { startEventServer } from "./events/server.js";
import { EventStore } from "./events/store.js";
import { createFeishuGateway } from "./feishu/gateway.js";
import { createFeishuMessagePipeline } from "./feishu/message-pipeline.js";
import { startOutcomeServer } from "./outcome/server.js";
import { createPiRunOrchestrator } from "./run/create-pi-orchestrator.js";
import type { OnFailureCascade } from "./run/orchestrator.js";
import { createRunQueue } from "./run/queue.js";
import { startSupervisorLeaseWriter } from "./runtime/supervisor-lease.js";
import type { RuntimeOptions } from "./runtime-options.js";
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

export async function runBeacon(
  configPath: string,
  options: RuntimeOptions & { uiDirectory?: string | undefined },
): Promise<void> {
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
  const defaultFeishuProfileId = global.feishu?.defaultProfile;
  if (defaultFeishuProfileId) {
    if (!profiles.some((profile) => profile.id === defaultFeishuProfileId)) {
      throw new Error(
        `feishu.default_profile ${JSON.stringify(defaultFeishuProfileId)} does not match a loaded Profile`,
      );
    }
  }
  const credentialBindings = await resolveFeishuCredentialBindings(
    profiles.map((profile) => profile.id),
    global.secretsPath,
    defaultFeishuProfileId
      ? { defaultProfileId: defaultFeishuProfileId }
      : undefined,
  );
  const wsListeners = feishuWsListenerProfileIds(credentialBindings);

  const eventProducers = global.events
    ? await loadEventCredentials(global.events.credentialsPath)
    : [];
  const supervisorLeasePath = join(
    global.homeDirectory,
    "state",
    "supervisor.lease",
  );
  const supervisorLease = startSupervisorLeaseWriter(supervisorLeasePath);
  const outcomes = await startOutcomeServer({
    directory: join(global.homeDirectory, "state", "outcomes"),
  });
  const queue = createRunQueue(global.runs, profiles);
  /**
   * Dashboard starts before Profile contexts exist; bind reload after map.
   * Absent binding → PUT keeps appliesOnRestart: true (compat).
   */
  const modelReloadBinding: {
    reload?: ((profileId: string) => Promise<boolean>) | undefined;
  } = {};
  let dashboard: DashboardServer | undefined;
  try {
    if (global.dashboard.enabled) {
      dashboard = await startDashboard({
        uiDirectory: options.uiDirectory,
        listen: global.dashboard.listen,
        port: global.dashboard.port,
        profilesDirectory: global.profilesDirectory,
        sessionDirectory: global.pi.sessionDirectory,
        piExecutable: global.pi.executable,
        reloadProfileModel: async (profileId) => {
          if (!modelReloadBinding.reload) return false;
          return modelReloadBinding.reload(profileId);
        },
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
  const onFailureProfileId = global.runs.onFailureProfile;
  /** Late-bound after all Profile contexts exist (cascades cross orchestrators). */
  const onFailureBinding: { cascade?: OnFailureCascade } = {};
  const onFailureCascade: OnFailureCascade | undefined = onFailureProfileId
    ? {
        profileId: onFailureProfileId,
        enqueue(payload) {
          if (!onFailureBinding.cascade) {
            return Promise.reject(
              new Error("on_failure cascade is not ready yet"),
            );
          }
          return onFailureBinding.cascade.enqueue(payload);
        },
      }
    : undefined;
  const contexts = profiles.map((profile, index) => {
    const binding = credentialBindings[index]!;
    const gateway = createFeishuGateway(binding.credentials);
    const store = new TriggerStore(profile.directory, profile.id);
    const orchestrator = createPiRunOrchestrator({
      beaconCliPath: options.beaconCliPath,
      config: global,
      runtimeEnvironment,
      profile,
      store,
      queue,
      outcomes,
      delivery: gateway,
      ...(onFailureCascade ? { onFailureCascade } : {}),
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
    return {
      profile,
      store,
      messagePipeline,
      orchestrator,
      reconciler,
      binding,
    };
  });

  modelReloadBinding.reload = async (profileId) => {
    const context = contexts.find((entry) => entry.profile.id === profileId);
    if (!context) return false;
    const reloaded = await loadProfile(profileId, global.profilesDirectory, {
      channels,
      channelsPath: global.channelsPath,
    });
    patchProfileModelFields(
      context.profile,
      reloaded.model,
      reloaded.modelPool,
    );
    return true;
  };

  if (onFailureProfileId) {
    const triage = contexts.find(
      (context) => context.profile.id === onFailureProfileId,
    );
    if (!triage) {
      throw new Error(
        `runs.on_failure_profile ${JSON.stringify(onFailureProfileId)} does not match a loaded Profile`,
      );
    }
    if (!triage.profile.admin) {
      throw new Error(
        `runs.on_failure_profile ${JSON.stringify(onFailureProfileId)} must declare admin`,
      );
    }
    const triageAdminChatId = triage.profile.admin.chatId;
    onFailureBinding.cascade = {
      profileId: onFailureProfileId,
      async enqueue(payload) {
        const input: TriggerInput = {
          kind: "on_failure",
          failedProfileId: payload.failedProfileId,
          failedRunId: payload.failedRunId,
          code: payload.code,
          summary: payload.summary,
          finishedAt: payload.finishedAt,
        };
        const claimed = await triage.store.claim({
          sourceKey: [
            "on_failure",
            payload.failedProfileId,
            payload.failedRunId,
          ],
          target: { kind: "chat", chatId: triageAdminChatId },
          input,
        });
        if (!claimed.created) return;
        await triage.orchestrator.process(
          claimed.record.triggerKey,
          async () => input,
        );
      },
    };
    console.log(
      `[beacon] on_failure cascades to profile=${onFailureProfileId}`,
    );
  }

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
    gateways = contexts.map(({ profile, messagePipeline, binding }) => {
      const poolNote = profile.modelPool?.length
        ? ` model_pool=${profile.modelPool.length}`
        : "";
      console.log(
        `[beacon] starting Profile id=${profile.id} runtime=${profile.runtime} provider=${profile.model.provider} model=${profile.model.id}${poolNote}`,
      );
      if (wsListeners.has(profile.id)) {
        console.log(
          `[beacon] Feishu WS listener profile=${profile.id} app_id=${binding.credentials.appId}`,
        );
        return messagePipeline.run(shutdown.promise);
      }
      console.log(
        `[beacon] Feishu outbound-only profile=${profile.id} via default_profile=${binding.sourceProfileId} app_id=${binding.credentials.appId}`,
      );
      // Shared default app: reuse credentials for Delivery, but do not open a
      // second WebSocket to the same Feishu app (inbound events stay on the
      // dedicated listener Profile).
      return shutdown.promise;
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
    supervisorLease.stop();
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
