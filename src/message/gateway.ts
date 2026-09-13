import type { DeliveryAdapter } from "../run/orchestrator.js";

export type MessageGateway<Event, ReferencedMessage> = DeliveryAdapter & {
  run(
    handleEvent: (event: Event) => Promise<unknown>,
    shutdown: Promise<void>,
  ): Promise<void>;
  acknowledge(messageId: string): Promise<void>;
  fetchMessage(messageId: string): Promise<ReferencedMessage>;
};
