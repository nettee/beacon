import type {
  DeliveryTarget,
  ReplyDeliveryTarget,
} from "../../src/domain/types.js";
import type { FeishuMessageEvent } from "../../src/feishu/intake.js";
import type { FeishuMessageGateway } from "../../src/feishu/message-gateway.js";
import type { FetchedMessage } from "../../src/feishu/trigger-input.js";

export type ObservedDelivery = {
  target: ReplyDeliveryTarget;
  text: string;
};

type IntakeResult = "accepted" | "duplicate" | "ignored";

export type InMemoryGatewayClient = {
  send(text: string): Promise<{ intake: IntakeResult; messageId: string }>;
  acknowledgedMessageIds(): string[];
  deliveries(): ObservedDelivery[];
};

export function createInMemoryFeishuGateway(): {
  gateway: FeishuMessageGateway;
  client: InMemoryGatewayClient;
} {
  let handleEvent:
    | ((event: FeishuMessageEvent) => Promise<unknown>)
    | undefined;
  const acknowledged: string[] = [];
  const observedDeliveries: ObservedDelivery[] = [];

  const gateway: FeishuMessageGateway = {
    async run(handle, shutdown) {
      if (handleEvent) throw new Error("In-memory Gateway is already running");
      handleEvent = handle;
      try {
        await shutdown;
      } finally {
        handleEvent = undefined;
      }
    },
    async acknowledge(messageId) {
      acknowledged.push(messageId);
    },
    async fetchMessage(messageId): Promise<FetchedMessage> {
      throw new Error(
        `Message E2E unexpectedly fetched quoted message ${messageId}`,
      );
    },
    async deliver(target: DeliveryTarget, text: string) {
      if (target.kind !== "reply") {
        throw new Error(
          `Message E2E requires a reply Delivery Target, received ${target.kind}`,
        );
      }
      observedDeliveries.push({ target: { ...target }, text });
      return { providerRequestId: "message-e2e-in-memory-gateway" };
    },
  };

  const client: InMemoryGatewayClient = {
    async send(text) {
      if (!handleEvent) throw new Error("In-memory Gateway is not running");
      const messageId = `om_${crypto.randomUUID()}`;
      const result = await handleEvent({
        event_id: `evt_${crypto.randomUUID()}`,
        sender: {
          sender_type: "user",
          sender_id: { open_id: "ou_message_e2e" },
        },
        message: {
          message_id: messageId,
          chat_id: "oc_message_e2e",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      if (
        result !== "accepted" &&
        result !== "duplicate" &&
        result !== "ignored"
      ) {
        throw new Error(`Unexpected Intake result: ${String(result)}`);
      }
      return { intake: result, messageId };
    },
    acknowledgedMessageIds: () => [...acknowledged],
    deliveries: () =>
      observedDeliveries.map((delivery) => ({
        target: { ...delivery.target },
        text: delivery.text,
      })),
  };

  return { gateway, client };
}
