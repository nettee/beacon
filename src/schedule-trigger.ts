import { randomUUID } from "node:crypto";

import { loadGlobalConfig } from "./config/global.js";
import { type Profile, profileAdminChatId } from "./config/profile.js";
import { loadProfileRegistry } from "./config/registry.js";
import { loadRuntimeEnvironment } from "./config/runtime-environment.js";
import { loadFeishuCredentials } from "./config/secrets.js";
import type { TriggerRecord } from "./domain/types.js";
import { createFeishuGateway } from "./feishu/gateway.js";
import { startOutcomeServer } from "./outcome/server.js";
import { createPiRunOrchestrator } from "./run/create-pi-orchestrator.js";
import { RunQueue } from "./run/queue.js";
import { TriggerStore } from "./state/trigger-store.js";

function findSchedule(
  profile: Profile,
  scheduleId: string,
): Profile["schedules"][number] {
  const schedule = profile.schedules.find(
    (candidate) => candidate.id === scheduleId,
  );
  if (!schedule) {
    throw new Error(`Unknown Schedule in Profile ${profile.id}: ${scheduleId}`);
  }
  return schedule;
}

export async function triggerScheduleOnce(options: {
  profile: Profile;
  scheduleId: string;
  store: TriggerStore;
  process(
    triggerKey: string,
    normalize: () => Promise<{
      kind: "schedule";
      scheduleId: string;
      scheduledFor: string;
      text: string;
    }>,
  ): Promise<void>;
  now?: (() => Date) | undefined;
  id?: (() => string) | undefined;
}): Promise<TriggerRecord> {
  const schedule = findSchedule(options.profile, options.scheduleId);

  const scheduledFor = (options.now ?? (() => new Date()))().toISOString();
  const invocationId = (options.id ?? randomUUID)();
  const claim = await options.store.claim({
    sourceKey: ["manual-schedule", schedule.id, invocationId],
    target: { kind: "chat", chatId: profileAdminChatId(options.profile) },
    ...(schedule.notify
      ? { notifyTarget: { kind: "chat", chatId: schedule.notify.chatId } }
      : {}),
    ingress: {
      invocation: "manual",
      scheduleId: schedule.id,
      scheduledFor,
      text: schedule.input,
    },
  });
  if (!claim.created) {
    throw new Error(`Duplicate manual Schedule invocation: ${invocationId}`);
  }

  await options.process(claim.record.triggerKey, async () => ({
    kind: "schedule",
    scheduleId: schedule.id,
    scheduledFor,
    text: schedule.input,
  }));

  const record = (await options.store.list()).find(
    (candidate) => candidate.triggerKey === claim.record.triggerKey,
  );
  if (!record?.run) {
    throw new Error(
      `Schedule Trigger produced no Run record: trigger_id=${claim.record.triggerId}`,
    );
  }
  if (record.run.state !== "succeeded" || !record.finalOutcome) {
    const failure =
      record.run.failure?.code ??
      (!record.finalOutcome ? "outcome_missing" : "unknown");
    const detail = record.run.failure?.summary;
    throw new Error(
      `Schedule Trigger failed (run_id=${record.run.runId}): ${failure}${
        detail ? ` — ${detail}` : ""
      }`,
    );
  }
  return record;
}

export async function runScheduleTrigger(
  configPath: string,
  profileId: string,
  scheduleId: string,
): Promise<void> {
  const global = await loadGlobalConfig(configPath);
  const runtimeEnvironment = await loadRuntimeEnvironment(
    global.runtimeEnvironmentPath,
  );
  const profiles = await loadProfileRegistry(global.profilesDirectory);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown Profile: ${profileId}`);
  findSchedule(profile, scheduleId);
  const credentials = await loadFeishuCredentials(
    profile.id,
    global.secretsPath,
  );
  const outcomes = await startOutcomeServer();
  try {
    const store = new TriggerStore(profile.directory, profile.id);
    const orchestrator = createPiRunOrchestrator({
      config: global,
      runtimeEnvironment,
      profile,
      store,
      queue: new RunQueue(global.runs.maxConcurrent, global.runs.maxQueued),
      outcomes,
      delivery: createFeishuGateway(credentials),
    });
    const record = await triggerScheduleOnce({
      profile,
      scheduleId,
      store,
      process: (triggerKey, normalize) =>
        orchestrator.process(triggerKey, normalize),
    });
    console.log(
      `[beacon] Schedule Trigger succeeded run_id=${record.run!.runId}`,
    );
  } finally {
    await outcomes.close();
  }
}
