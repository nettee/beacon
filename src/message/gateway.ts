import type { DeliveryAdapter } from "../run/orchestrator.js";

export type Acknowledgement = {
  clear(): Promise<void>;
};

export type MessageGateway<Event, ReferencedMessage> = DeliveryAdapter & {
  run(
    handleEvent: (event: Event) => Promise<unknown>,
    shutdown: Promise<void>,
  ): Promise<void>;
  acknowledge(messageId: string): Promise<Acknowledgement>;
  fetchMessage(messageId: string): Promise<ReferencedMessage>;
};
