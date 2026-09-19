import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import type { Profile } from "../config/profile.js";
import type {
  DeliveryTarget,
  FailureCode,
  FinalOutcomeContent,
  TriggerInput,
  TriggerRecord,
} from "../domain/types.js";
import type { OutcomeServer } from "../outcome/server.js";
import { PiRuntimeError } from "../runtime/pi-rpc.js";
import { buildAgentSystemPrompt } from "../runtime/system-prompt.js";
import type { TriggerStore } from "../state/trigger-store.js";
import type { AgentRuntimeRunner } from "./profile-runner.js";
import type { RunQueue } from "./queue.js";

export type DeliveryAdapter = {
  deliver(
    target: DeliveryTarget,
    outcome: FinalOutcomeContent,
    deliveryId: string,
  ): Promise<{ providerRequestId?: string | undefined }>;
};

export type RunOrchestratorOptions = {
  profile: Profile;
  store: TriggerStore;
  queue: RunQueue;
  outcomes: OutcomeServer;
  beaconCliPath: string;
  runAgent: AgentRuntimeRunner;
  delivery: DeliveryAdapter;
  sessionDirectory: string;
  now?: (() => Date) | undefined;
  id?: (() => string) | undefined;
};

function promptFor(input: TriggerInput): string {
  if (input.kind === "manual") {
    return ["An operator manually triggered this Run.", "", input.text].join(
      "\n",
    );
  }
  if (input.kind === "schedule") {
    return [
      "A configured Schedule triggered this Run.",
      `schedule_id: ${input.scheduleId}`,
      `scheduled_for: ${input.scheduledFor}`,
      "",
      input.text,
    ].join("\n");
  }
  return [
    "A Feishu user triggered this Run. Treat the following JSON as user-provided conversation context.",
    "quoted_messages is the complete quoted chain in chronological order (oldest first).",
    "current_message is the message that triggered this Run.",
    JSON.stringify(
      {
        chat_type: input.chatType,
        quoted_messages: input.quotedMessages.map((message) => ({
          sender_type: message.senderType,
          message_type: message.messageType,
          content: message.content,
        })),
        current_message: {
          sender_type: input.currentMessage.senderType,
          message_type: input.currentMessage.messageType,
          content: input.currentMessage.content,
        },
      },
      null,
      2,
    ),
  ].join("\n");
}

function summary(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 4096) || "unknown failure";
}

export class RunOrchestrator {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: RunOrchestratorOptions) {
    if (!isAbsolute(options.sessionDirectory)) {
      throw new Error("Pi session directory must be absolute");
    }
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private newRun(
    runId: string,
    state: "queued" | "failed",
    failure?: { code: FailureCode; summary: string },
  ) {
    const timestamp = this.timestamp();
    return {
      runId,
      sessionId: runId,
      sessionPath: join(
        this.options.sessionDirectory,
        this.options.profile.id,
        runId,
      ),
      state,
      queuedAt: timestamp,
      ...(state === "failed" ? { finishedAt: timestamp } : {}),
      provider: this.options.profile.model.provider,
      model: this.options.profile.model.id,
      workspace: this.options.profile.workspace,
      promptDigest: createHash("sha256")
        .update(this.options.profile.prompt)
        .digest("hex"),
      ...(failure ? { failure } : {}),
    } as const;
  }

  private async deliver(triggerKey: string, create = true): Promise<void> {
    const deliveryId = `del_${this.id()}`;
    let record: TriggerRecord;
    if (create) {
      record = await this.options.store.update(triggerKey, (current) => ({
        ...current,
        delivery: {
          deliveryId,
          target: current.target,
          state: "pending",
        },
      }));
    } else {
      record = (await this.options.store.list()).find(
        (candidate) => candidate.triggerKey === triggerKey,
      )!;
      if (record.delivery?.state !== "pending") {
        throw new Error(
          `Cannot resume non-pending Delivery for Trigger ${triggerKey}`,
        );
      }
    }
    record = await this.options.store.update(triggerKey, (current) => ({
      ...current,
      delivery: {
        ...current.delivery!,
        state: "delivering",
        startedAt: this.timestamp(),
      },
    }));
    try {
      const result = await this.options.delivery.deliver(
        record.target,
        record.finalOutcome!.content,
        record.delivery!.deliveryId,
      );
      await this.options.store.update(triggerKey, (current) => ({
        ...current,
        delivery: {
          ...current.delivery!,
          state: "delivered",
          finishedAt: this.timestamp(),
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
        },
      }));
    } catch (error) {
      await this.options.store.update(triggerKey, (current) => ({
        ...current,
        delivery: {
          ...current.delivery!,
          state: "failed",
          finishedAt: this.timestamp(),
          failure: { code: "delivery_api_failed", summary: summary(error) },
        },
      }));
    }
  }

  private async fail(
    triggerKey: string,
    runId: string,
    code: FailureCode,
    error: unknown,
  ): Promise<void> {
    const detail = summary(error);
    await this.options.store.update(triggerKey, (current) => ({
      ...current,
      run: {
        ...(current.run ?? this.newRun(runId, "queued")),
        state: "failed",
        finishedAt: this.timestamp(),
        failure: { code, summary: detail },
      },
      finalOutcome: {
        origin: "beacon_failure",
        content: {
          kind: "text",
          text: `处理失败（run_id=${runId}），请查看 Beacon 本地记录。`,
        },
        submittedAt: this.timestamp(),
      },
    }));
    await this.deliver(triggerKey);
  }

  private async execute(
    triggerKey: string,
    input: TriggerInput,
    runId: string,
  ): Promise<void> {
    const record = await this.options.store.update(triggerKey, (current) => {
      if (!current.run) {
        throw new Error(`Cannot execute Trigger ${triggerKey} without a Run`);
      }
      const session =
        current.run.sessionId && current.run.sessionPath
          ? {
              sessionId: current.run.sessionId,
              sessionPath: current.run.sessionPath,
            }
          : {
              // Migration for queued records written by Beacon <= 0.1.2.
              sessionId: current.run.runId,
              sessionPath: join(
                this.options.sessionDirectory,
                this.options.profile.id,
                current.run.runId,
              ),
            };
      return {
        ...current,
        run: {
          ...current.run,
          ...session,
          state: "starting",
          startedAt: this.timestamp(),
        },
      };
    });
    await this.options.store.update(triggerKey, (current) => ({
      ...current,
      run: { ...current.run!, state: "running" },
    }));

    const submission = this.options.outcomes.openRun();
    try {
      const completion = await this.options.runAgent({
        prompt: promptFor(input),
        workspace: this.options.profile.workspace,
        provider: this.options.profile.model.provider,
        model: this.options.profile.model.id,
        systemPrompt: buildAgentSystemPrompt(this.options.profile),
        outcome: { ...submission.binding, cliPath: this.options.beaconCliPath },
        session: {
          id: record.run!.sessionId!,
          path: record.run!.sessionPath!,
          name: `Beacon ${this.options.profile.id} ${runId}`,
        },
      });
      const outcome = submission.take();
      await this.options.store.update(triggerKey, (current) => ({
        ...current,
        run: {
          ...current.run!,
          state: "succeeded",
          finishedAt: this.timestamp(),
          provider: completion.provider,
          model: completion.model,
        },
        finalOutcome: {
          origin: "agent",
          content: outcome,
          submittedAt: this.timestamp(),
        },
      }));
      if (outcome.kind !== "no_reply") await this.deliver(triggerKey);
    } catch (error) {
      submission.cancel();
      const code: FailureCode =
        error instanceof PiRuntimeError
          ? error.code
          : error instanceof Error &&
              /submitting a Final Outcome/.test(error.message)
            ? "outcome_missing"
            : "runtime_exit_failed";
      await this.fail(triggerKey, runId, code, error);
    }
  }

  async process(
    triggerKey: string,
    normalize: () => Promise<TriggerInput>,
  ): Promise<void> {
    const runId = `run_${this.id()}`;
    let input: TriggerInput;
    try {
      input = await normalize();
    } catch (error) {
      await this.options.store.update(triggerKey, (current) => ({
        ...current,
        run: this.newRun(runId, "failed", {
          code: "trigger_normalization_failed",
          summary: summary(error),
        }),
        finalOutcome: {
          origin: "beacon_failure",
          content: {
            kind: "text",
            text: `处理失败（run_id=${runId}），请查看 Beacon 本地记录。`,
          },
          submittedAt: this.timestamp(),
        },
      }));
      await this.deliver(triggerKey);
      return;
    }

    await this.options.store.update(triggerKey, (current) => ({
      ...current,
      input,
      run: this.newRun(runId, "queued"),
    }));
    const queued = this.options.queue.enqueue(() =>
      this.execute(triggerKey, input, runId),
    );
    if (!queued.accepted) {
      await this.fail(
        triggerKey,
        runId,
        "capacity_exceeded",
        "Run queue capacity exceeded",
      );
      return;
    }
    await queued.completion;
  }

  async recover(): Promise<void> {
    for (const record of await this.options.store.list()) {
      if (record.delivery?.state === "delivering") {
        await this.options.store.update(record.triggerKey, (current) => ({
          ...current,
          delivery: {
            ...current.delivery!,
            state: "failed",
            finishedAt: this.timestamp(),
            failure: {
              code: "delivery_interrupted",
              summary: "Service restarted while Delivery result was unknown",
            },
          },
        }));
        continue;
      }
      if (record.delivery?.state === "pending") {
        await this.deliver(record.triggerKey, false);
        continue;
      }
      if (record.run?.state === "starting" || record.run?.state === "running") {
        await this.fail(
          record.triggerKey,
          record.run.runId,
          "service_interrupted",
          "Service restarted while Run was active",
        );
        continue;
      }
      if (record.run?.state === "queued" && record.input) {
        const queued = this.options.queue.enqueue(() =>
          this.execute(record.triggerKey, record.input!, record.run!.runId),
        );
        if (!queued.accepted) {
          throw new Error(
            "Persisted queued Runs exceed configured queue capacity",
          );
        }
        await queued.completion;
        continue;
      }
      if (!record.run) {
        await this.fail(
          record.triggerKey,
          `run_${this.id()}`,
          "service_interrupted",
          "Service restarted before Trigger normalization completed",
        );
        continue;
      }
      if (
        record.finalOutcome &&
        record.finalOutcome.content.kind !== "no_reply" &&
        !record.delivery &&
        (record.run.state === "succeeded" || record.run.state === "failed")
      ) {
        await this.deliver(record.triggerKey);
      }
    }
  }
}
