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

export type TriggerInput = FeishuMessageInput | ScheduleInput | ManualInput;

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

/** Text, silent, or an inbound `reply_card` interactive quote-reply. */
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

export type DeliveryContent = TextReplyContent | CardContent;

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
  workspace: string;
  promptDigest: string;
  /** Full `--system-prompt` text sent to Pi. Absent on records written before this field. */
  systemPrompt?: string | undefined;
  failure?: Failure | undefined;
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
  delivery?: DeliveryRecord | undefined;
  notifyDelivery?: DeliveryRecord | undefined;
};
