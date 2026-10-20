import type { CloudEvent } from "../events/cloudevent.js";

export type ReplyDeliveryTarget = { kind: "reply"; messageId: string };
export type ChatDeliveryTarget = { kind: "chat"; chatId: string };
export type LocalStdoutDeliveryTarget = { kind: "local_stdout" };
export type DeliveryTarget =
  | ReplyDeliveryTarget
  | ChatDeliveryTarget
  | LocalStdoutDeliveryTarget;

export type MessageSnapshot = {
  messageId: string;
  messageType: string;
  senderType: string;
  senderId?: string | undefined;
  content: unknown;
};

export type FeishuMessageInput = {
  kind: "feishu_message";
  eventId: string;
  chatType: "p2p" | "group";
  quotedMessages: MessageSnapshot[];
  /** Full Feishu topic/thread timeline (oldest first), excluding currentMessage. */
  threadMessages: MessageSnapshot[];
  currentMessage: MessageSnapshot;
};

export type ScheduleInput = {
  kind: "schedule";
  scheduleId: string;
  scheduledFor: string;
  text: string;
};

export type ManualInput = {
  kind: "manual";
  text: string;
};

export type EventInput = {
  kind: "event";
  event: CloudEvent;
};

export const failureCodes = [
  "config_invalid",
  "secret_invalid",
  "gateway_terminal",
  "trigger_persist_failed",
  "trigger_normalization_failed",
  "schedule_state_invalid",
  "capacity_exceeded",
  "runtime_spawn_failed",
  "runtime_protocol_error",
  "runtime_timeout",
  "runtime_exit_failed",
  "outcome_missing",
  "outcome_invalid",
  "service_interrupted",
  "delivery_api_failed",
  "delivery_interrupted",
] as const;

export type FailureCode = (typeof failureCodes)[number];

/** Cascade Trigger when another Profile Run ends failed (same moment as Feishu failure notify). */
export type OnFailureInput = {
  kind: "on_failure";
  failedProfileId: string;
  failedRunId: string;
  code: FailureCode;
  summary: string;
  finishedAt: string;
};

export type TriggerInput =
  | FeishuMessageInput
  | ScheduleInput
  | ManualInput
  | EventInput
  | OnFailureInput;

export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed";
export type DeliveryState = "pending" | "delivering" | "delivered" | "failed";

export type Failure = { code: FailureCode; summary: string };

export type TextReplyContent = { kind: "text"; text: string };
export type NoReplyContent = { kind: "no_reply"; reason: string };

export type CardContent = {
  kind: "card";
  title: string;
  content: string;
  buttons: Array<{ label: string; url: string }>;
};

/** Text, silent, or a `reply_card` interactive message on the conversational channel. */
export type ReplyContent = TextReplyContent | NoReplyContent | CardContent;

export type FinalOutcomeContent = {
  reply: ReplyContent;
  notify?: CardContent | undefined;
};

export const feedbackPriorities = ["high", "medium"] as const;
export type FeedbackPriority = (typeof feedbackPriorities)[number];

export type FeedbackItem = {
  priority: FeedbackPriority;
  summary: string;
};

export type FeedbackContent = { items: FeedbackItem[] };

export type FeedbackRecord = {
  items: FeedbackItem[];
  submittedAt: string;
};

/** Observability-gap feedback may include low; instruction feedback may not. */
export const observabilityFeedbackPriorities = [
  "high",
  "medium",
  "low",
] as const;
export type ObservabilityFeedbackPriority =
  (typeof observabilityFeedbackPriorities)[number];

export type ObservabilityFeedbackItem = {
  priority: ObservabilityFeedbackPriority;
  summary: string;
};

export type ObservabilityFeedbackContent = {
  items: ObservabilityFeedbackItem[];
};

export type ObservabilityFeedbackRecord = {
  items: ObservabilityFeedbackItem[];
  submittedAt: string;
};

export type DeliveryContent = TextReplyContent | CardContent;

/** Detached Pi worker handle persisted so a new Beacon daemon can adopt the Run. */
export type AgentRuntimeRecord = {
  workerPid: number;
  lifecycleDirectory: string;
  runToken: string;
  supervisorLeasePath: string;
  orphanAfterMs: number;
};

/** Pi-attributed token/cost totals captured from the session JSONL at Run end. */
export type RunUsageRecord = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  source: "pi_session";
  capturedAt: string;
};

export type RunRecord = {
  runId: string;
  /** Pi session ID. Absent only on records written before session persistence. */
  sessionId?: string | undefined;
  /** Dedicated directory containing this Run's Pi session JSONL file. */
  sessionPath?: string | undefined;
  state: RunState;
  queuedAt: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  provider: string;
  model: string;
  /**
   * Pi `--thinking` level selected for this Run (from profile model / model_pool).
   * Absent when unset or on records written before this field.
   */
  thinking?: string | undefined;
  playbook: string;
  promptDigest: string;
  /** Full `--system-prompt` text sent to Pi. Absent on records written before this field. */
  systemPrompt?: string | undefined;
  /** Present while a detached Pi worker owns the in-flight Run. */
  agent?: AgentRuntimeRecord | undefined;
  failure?: Failure | undefined;
  /**
   * Token/cost totals for this Run's time window in the Pi session JSONL.
   * Absent on records written before usage capture, or when no session file exists.
   */
  usage?: RunUsageRecord | undefined;
};

export type FinalOutcomeRecord = {
  origin: "agent" | "beacon_failure";
  content: FinalOutcomeContent;
  submittedAt: string;
};

export type DeliveryRecord = {
  deliveryId: string;
  target: DeliveryTarget;
  state: DeliveryState;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  providerRequestId?: string | undefined;
  failure?: Failure | undefined;
};

export type TriggerRecord = {
  version: 1;
  triggerKey: string;
  triggerId: string;
  profileId: string;
  sourceKey: string[];
  acceptedAt: string;
  target: DeliveryTarget;
  notifyTarget?: DeliveryTarget | undefined;
  input?: TriggerInput | undefined;
  ingress?: Record<string, unknown> | undefined;
  run?: RunRecord | undefined;
  finalOutcome?: FinalOutcomeRecord | undefined;
  /** Present only when the Agent called `submit_feedback`. */
  feedback?: FeedbackRecord | undefined;
  /** Legacy field retained for old records; Agents no longer submit this. */
  observabilityFeedback?: ObservabilityFeedbackRecord | undefined;
  delivery?: DeliveryRecord | undefined;
  notifyDelivery?: DeliveryRecord | undefined;
};
