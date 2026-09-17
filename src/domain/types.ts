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

export type FinalOutcomeContent =
  | { kind: "text"; text: string }
  | { kind: "no_reply"; reason: string }
  | {
      kind: "card";
      title: string;
      content: string;
      buttons: Array<{ label: string; url: string }>;
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
  workspace: string;
  promptDigest: string;
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
  input?: TriggerInput | undefined;
  ingress?: Record<string, unknown> | undefined;
  run?: RunRecord | undefined;
  finalOutcome?: FinalOutcomeRecord | undefined;
  delivery?: DeliveryRecord | undefined;
};
