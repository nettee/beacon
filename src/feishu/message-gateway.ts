import type { MessageGateway } from "../message/gateway.js";
import type { FeishuMessageEvent } from "./intake.js";
import type { FetchedMessage } from "./trigger-input.js";

export type FeishuMessageGateway = MessageGateway<
  FeishuMessageEvent,
  FetchedMessage
>;
