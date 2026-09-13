import type { TriggerInput } from "../domain/types.js";
import type { TriggerStore } from "../state/trigger-store.js";
import {
  buildFeishuTriggerInput,
  type FetchedMessage,
} from "./trigger-input.js";

export type FeishuMessageEvent = {
  event_id?: string | undefined;
  sender: {
    sender_type: string;
    sender_id?: { open_id?: string | undefined } | undefined;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    parent_id?: string | undefined;
  };
};

export type FeishuIntakeOptions = {
  store: TriggerStore;
  process(
    triggerKey: string,
    normalize: () => Promise<TriggerInput>,
  ): Promise<void>;
  fetchMessage(messageId: string): Promise<FetchedMessage>;
  acknowledge(messageId: string): Promise<void>;
  onFatal(error: Error): void;
};

export class FeishuIntake {
  private readonly active = new Set<Promise<void>>();

  constructor(private readonly options: FeishuIntakeOptions) {}

  async handle(
    event: FeishuMessageEvent,
  ): Promise<"accepted" | "duplicate" | "ignored"> {
    if (
      event.sender.sender_type !== "user" ||
      (event.message.chat_type !== "p2p" && event.message.chat_type !== "group")
    ) {
      return "ignored";
    }
    if (!event.event_id) throw new Error("Feishu event_id is required");

    const claim = await this.options.store.claim({
      sourceKey: ["feishu", event.event_id],
      target: { kind: "reply", messageId: event.message.message_id },
      ingress: {
        eventId: event.event_id,
        messageId: event.message.message_id,
        chatId: event.message.chat_id,
        chatType: event.message.chat_type,
        senderId: event.sender.sender_id?.open_id,
        senderType: event.sender.sender_type,
        messageType: event.message.message_type,
        content: event.message.content,
        ...(event.message.parent_id
          ? { parentMessageId: event.message.parent_id }
          : {}),
      },
    });
    if (!claim.created) return "duplicate";

    void this.options
      .acknowledge(event.message.message_id)
      .catch((error: unknown) => {
        console.error(
          `[beacon] non-critical acknowledgement failure message_id=${event.message.message_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    const task = this.options.process(claim.record.triggerKey, async () => {
      const normalized = await buildFeishuTriggerInput(
        {
          messageId: event.message.message_id,
          chatId: event.message.chat_id,
          chatType: event.message.chat_type,
          senderId: event.sender.sender_id?.open_id,
          senderType: event.sender.sender_type,
          messageType: event.message.message_type,
          content: event.message.content,
          parentMessageId: event.message.parent_id,
        },
        this.options.fetchMessage,
      );
      return {
        kind: "feishu_message",
        eventId: event.event_id!,
        chatType: normalized.source.chatType as "p2p" | "group",
        quotedMessages: normalized.quotedMessages,
        currentMessage: normalized.message,
      };
    });
    this.active.add(task);
    void task
      .catch((error: unknown) =>
        this.options.onFatal(
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      .finally(() => this.active.delete(task));
    return "accepted";
  }

  async drain(): Promise<void> {
    await Promise.all([...this.active]);
  }
}
