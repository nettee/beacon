import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import type { Profile } from "../config/profile.js";
import type {
  DeliveryContent,
  DeliveryTarget,
  FailureCode,
  FeedbackRecord,
  FinalOutcomeContent,
  TriggerInput,
  TriggerRecord,
} from "../domain/types.js";
import {
  isMissingReplyOutcomeError,
  MISSING_REPLY_OUTCOME_SUMMARY,
} from "../outcome/content.js";
import { inboundOutOfRoleReply } from "../outcome/instructions.js";
import type { OutcomeServer } from "../outcome/server.js";
import { PiRuntimeError } from "../runtime/pi-rpc.js";
import {
  type AgentSystemPromptTrigger,
  agentSystemPromptTrigger,
  buildAgentSystemPrompt,
  profilePromptDigest,
} from "../runtime/system-prompt.js";
import type { TriggerStore } from "../state/trigger-store.js";
import type { AgentRuntimeRunner } from "./profile-runner.js";
import type { RunQueue } from "./queue.js";

export type DeliveryAdapter = {
  deliver(
    target: DeliveryTarget,
    outcome: DeliveryContent,
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

const FAILURE_DETAIL_LIMIT = 400;
const THINKING_SNIPPET_LIMIT = 120;

function clipForFeishu(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/** Compact settle-side hint for outcome_missing (Feishu / admin). */
export function formatSettleFailureHint(parts: {
  stopReason?: string | undefined;
  thinking?: string | undefined;
  text?: string | undefined;
}): string | undefined {
  const bits: string[] = [];
  if (parts.stopReason?.trim()) {
    bits.push(`末轮 stopReason=${parts.stopReason.trim()}`);
  }
  const thought = parts.thinking?.trim() || parts.text?.trim();
  if (thought) {
    bits.push(
      `thinking：「${clipForFeishu(thought, THINKING_SNIPPET_LIMIT)}」`,
    );
  }
  return bits.length > 0 ? bits.join("；") : undefined;
}

function detailBeyondMissingSummary(summaryText: string): string | undefined {
  if (summaryText === MISSING_REPLY_OUTCOME_SUMMARY) return undefined;
  if (summaryText.startsWith(MISSING_REPLY_OUTCOME_SUMMARY)) {
    const rest = summaryText
      .slice(MISSING_REPLY_OUTCOME_SUMMARY.length)
      .replace(/^[\s.;]+/, "")
      .trim();
    return rest ? clipForFeishu(rest, FAILURE_DETAIL_LIMIT) : undefined;
  }
  return clipForFeishu(summaryText, FAILURE_DETAIL_LIMIT);
}

/** User-visible (Feishu/admin) failure text. Keep codes stable; prefer concrete reasons. */
export function formatFailureReplyText(
  runId: string,
  failure?: { code: FailureCode; summary: string },
): string {
  if (failure?.code === "outcome_missing") {
    const parts = [
      `处理失败（run_id=${runId}，code=outcome_missing）：`,
      "期望恰好调用一次 `reply_text`、`reply_card` 或 `no_reply`，但 Agent 已结束且均未提交。",
    ];
    const detail = failure.summary
      ? detailBeyondMissingSummary(failure.summary)
      : undefined;
    if (detail) parts.push(`详情：${detail}`);
    return parts.join("");
  }
  if (failure?.summary?.trim()) {
    return `处理失败（run_id=${runId}，code=${failure.code}）：${clipForFeishu(
      failure.summary,
      FAILURE_DETAIL_LIMIT,
    )}`;
  }
  if (failure) {
    return `处理失败（run_id=${runId}，code=${failure.code}），请查看 Beacon 本地记录。`;
  }
  return `处理失败（run_id=${runId}），请查看 Beacon 本地记录。`;
}

function failureOutcome(
  runId: string,
  failure?: { code: FailureCode; summary: string },
): FinalOutcomeContent {
  return {
    reply: {
      kind: "text",
      text: formatFailureReplyText(runId, failure),
    },
  };
}

function normalizeAgentOutcome(
  input: TriggerInput,
  outcome: FinalOutcomeContent,
  notifyTarget: DeliveryTarget | undefined,
): FinalOutcomeContent {
  if (input.kind !== "schedule" && outcome.notify) {
    throw new Error("notify_card is only valid on Schedule Runs");
  }
  if (outcome.notify && !notifyTarget) {
    throw new Error("notify_card requires a configured notify chat");
  }
  if (input.kind === "feishu_message" && outcome.reply.kind === "no_reply") {
    return { reply: { kind: "text", text: inboundOutOfRoleReply } };
  }
  return outcome;
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

  private async record(triggerKey: string): Promise<TriggerRecord> {
    const found = (await this.options.store.list()).find(
      (candidate) => candidate.triggerKey === triggerKey,
    );
    if (!found) throw new Error(`Unknown Trigger ${triggerKey}`);
    return found;
  }

  private agentSystemPrompt(
    trigger: AgentSystemPromptTrigger,
    existing?: string,
  ): string {
    return existing && existing.length > 0
      ? existing
      : buildAgentSystemPrompt(this.options.profile, trigger);
  }

  private triggerFor(
    record: TriggerRecord,
    input?: TriggerInput,
  ): AgentSystemPromptTrigger {
    return agentSystemPromptTrigger(input ?? record.input, record.notifyTarget);
  }

  private newRun(
    runId: string,
    state: "queued" | "failed",
    trigger: AgentSystemPromptTrigger,
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
      promptDigest: profilePromptDigest(this.options.profile),
      systemPrompt: this.agentSystemPrompt(trigger),
      ...(failure ? { failure } : {}),
    } as const;
  }

  private async deliverField(
    triggerKey: string,
    field: "delivery" | "notifyDelivery",
    target: DeliveryTarget,
    content: DeliveryContent,
    create = true,
  ): Promise<void> {
    const deliveryId = `del_${this.id()}`;
    if (create) {
      await this.options.store.update(triggerKey, (current) => ({
        ...current,
        [field]: {
          deliveryId,
          target,
          state: "pending" as const,
        },
      }));
    } else {
      const current = await this.record(triggerKey);
      if (current[field]?.state !== "pending") {
        return;
      }
    }
    await this.options.store.update(triggerKey, (current) => ({
      ...current,
      [field]: {
        ...current[field]!,
        state: "delivering",
        startedAt: this.timestamp(),
      },
    }));
    const live = await this.record(triggerKey);
    try {
      const result = await this.options.delivery.deliver(
        target,
        content,
        live[field]!.deliveryId,
      );
      await this.options.store.update(triggerKey, (current) => ({
        ...current,
        [field]: {
          ...current[field]!,
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
        [field]: {
          ...current[field]!,
          state: "failed",
          finishedAt: this.timestamp(),
          failure: { code: "delivery_api_failed", summary: summary(error) },
        },
      }));
    }
  }

  private async deliverOutcome(
    triggerKey: string,
    create = true,
  ): Promise<void> {
    const current = await this.record(triggerKey);
    const outcome = current.finalOutcome!.content;
    if (outcome.reply.kind === "text" || outcome.reply.kind === "card") {
      await this.deliverField(
        triggerKey,
        "delivery",
        current.target,
        outcome.reply,
        create && current.delivery === undefined,
      );
    }
    if (outcome.notify && current.notifyTarget) {
      await this.deliverField(
        triggerKey,
        "notifyDelivery",
        current.notifyTarget,
        outcome.notify,
        create && current.notifyDelivery === undefined,
      );
    }
  }

  private async fail(
    triggerKey: string,
    runId: string,
    code: FailureCode,
    error: unknown,
    submitted?: FeedbackRecord | undefined,
    settle?:
      | {
          stopReason?: string | undefined;
          thinking?: string | undefined;
          text?: string | undefined;
        }
      | undefined,
  ): Promise<void> {
    let detail = isMissingReplyOutcomeError(error)
      ? MISSING_REPLY_OUTCOME_SUMMARY
      : summary(error);
    if (code === "outcome_missing") {
      const hint = formatSettleFailureHint(settle ?? {});
      if (hint) detail = `${detail}. ${hint}`;
    }
    const failure = { code, summary: detail };
    await this.options.store.update(triggerKey, (current) => ({
      ...current,
      run: {
        ...(current.run ??
          this.newRun(runId, "queued", this.triggerFor(current))),
        state: "failed",
        finishedAt: this.timestamp(),
        failure,
      },
      finalOutcome: {
        origin: "beacon_failure",
        content: failureOutcome(runId, failure),
        submittedAt: this.timestamp(),
      },
      ...(submitted ? { feedback: submitted } : {}),
    }));
    await this.deliverOutcome(triggerKey);
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
              sessionId: current.run.runId,
              sessionPath: join(
                this.options.sessionDirectory,
                this.options.profile.id,
                current.run.runId,
              ),
            };
      const systemPrompt = this.agentSystemPrompt(
        this.triggerFor(current, input),
        current.run.systemPrompt,
      );
      return {
        ...current,
        run: {
          ...current.run,
          ...session,
          state: "starting" as const,
          startedAt: this.timestamp(),
          systemPrompt,
        },
      };
    });
    await this.options.store.update(triggerKey, (current) => ({
      ...current,
      run: { ...current.run!, state: "running" },
    }));

    const submission = this.options.outcomes.openRun();
    let settle:
      | {
          stopReason?: string | undefined;
          thinking?: string | undefined;
          text?: string | undefined;
        }
      | undefined;
    try {
      const completion = await this.options.runAgent({
        prompt: promptFor(input),
        workspace: this.options.profile.workspace,
        provider: this.options.profile.model.provider,
        model: this.options.profile.model.id,
        systemPrompt: record.run!.systemPrompt,
        outcome: { ...submission.binding, cliPath: this.options.beaconCliPath },
        session: {
          id: record.run!.sessionId!,
          path: record.run!.sessionPath!,
          name: `Beacon ${this.options.profile.id} ${runId}`,
        },
      });
      settle = {
        stopReason: completion.stopReason,
        thinking: completion.thinking,
        text: completion.text,
      };
      const submitted = submission.takeFeedback();
      const outcome = normalizeAgentOutcome(
        input,
        submission.take(),
        record.notifyTarget,
      );
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
        ...(submitted ? { feedback: submitted } : {}),
      }));
      await this.deliverOutcome(triggerKey);
    } catch (error) {
      const submitted = submission.takeFeedback();
      submission.cancel();
      const code: FailureCode =
        error instanceof PiRuntimeError
          ? error.code
          : isMissingReplyOutcomeError(error)
            ? "outcome_missing"
            : "runtime_exit_failed";
      await this.fail(triggerKey, runId, code, error, submitted, settle);
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
      const failure = {
        code: "trigger_normalization_failed" as const,
        summary: summary(error),
      };
      await this.options.store.update(triggerKey, (current) => ({
        ...current,
        run: this.newRun(runId, "failed", this.triggerFor(current), failure),
        finalOutcome: {
          origin: "beacon_failure",
          content: failureOutcome(runId, failure),
          submittedAt: this.timestamp(),
        },
      }));
      await this.deliverOutcome(triggerKey);
      return;
    }

    await this.options.store.update(triggerKey, (current) => ({
      ...current,
      input,
      run: this.newRun(runId, "queued", this.triggerFor(current, input)),
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
      for (const field of ["delivery", "notifyDelivery"] as const) {
        if (record[field]?.state === "delivering") {
          await this.options.store.update(record.triggerKey, (current) => ({
            ...current,
            [field]: {
              ...current[field]!,
              state: "failed",
              finishedAt: this.timestamp(),
              failure: {
                code: "delivery_interrupted",
                summary: "Service restarted while Delivery result was unknown",
              },
            },
          }));
        }
      }
      const latest = await this.record(record.triggerKey);
      if (
        latest.delivery?.state === "pending" ||
        latest.notifyDelivery?.state === "pending"
      ) {
        await this.deliverOutcome(latest.triggerKey, false);
        continue;
      }
      if (latest.run?.state === "starting" || latest.run?.state === "running") {
        await this.fail(
          latest.triggerKey,
          latest.run.runId,
          "service_interrupted",
          "Service restarted while Run was active",
        );
        continue;
      }
      if (latest.run?.state === "queued" && latest.input) {
        const queued = this.options.queue.enqueue(() =>
          this.execute(latest.triggerKey, latest.input!, latest.run!.runId),
        );
        if (!queued.accepted) {
          throw new Error(
            "Persisted queued Runs exceed configured queue capacity",
          );
        }
        await queued.completion;
        continue;
      }
      if (!latest.run) {
        await this.fail(
          latest.triggerKey,
          `run_${this.id()}`,
          "service_interrupted",
          "Service restarted before Trigger normalization completed",
        );
        continue;
      }
      if (
        latest.finalOutcome &&
        (latest.run.state === "succeeded" || latest.run.state === "failed")
      ) {
        const outcome = latest.finalOutcome.content;
        const missingReply =
          (outcome.reply.kind === "text" || outcome.reply.kind === "card") &&
          !latest.delivery;
        const missingNotify =
          Boolean(outcome.notify) &&
          Boolean(latest.notifyTarget) &&
          !latest.notifyDelivery;
        if (missingReply || missingNotify) {
          await this.deliverOutcome(latest.triggerKey);
        }
      }
    }
  }
}
