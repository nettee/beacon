import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuCredentials } from "../config/secrets.js";
import {
  buildFeishuTriggerInput,
  type FetchedMessage,
} from "./trigger-input.js";

type ApiResult = {
  code?: number | undefined;
  msg?: string | undefined;
};

function assertSucceeded(operation: string, result: ApiResult): void {
  if (result.code !== undefined && result.code !== 0) {
    throw new Error(
      `${operation} failed: code=${result.code} msg=${result.msg ?? "unknown"}`,
    );
  }
}

function textContent(text: string): string {
  return JSON.stringify({ text });
}

export function shouldExerciseReplyExperiment(
  chatType: string,
  messageId: string,
  processedMessageIds: ReadonlySet<string>,
): boolean {
  return (
    (chatType === "p2p" || chatType === "group") &&
    !processedMessageIds.has(messageId)
  );
}

export async function runFeishuReplyExperiment(
  credentials: FeishuCredentials,
): Promise<void> {
  const api = new Lark.Client(credentials);
  const processedMessageIds = new Set<string>();

  async function attempt(
    label: string,
    operation: () => Promise<ApiResult>,
  ): Promise<void> {
    try {
      const result = await operation();
      assertSucceeded(label, result);
      console.log(`[beacon] succeeded: ${label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[beacon] failed: ${label}: ${message}`);
    }
  }

  async function fetchMessage(messageId: string): Promise<FetchedMessage> {
    const result = await api.im.v1.message.get({
      path: { message_id: messageId },
    });
    assertSucceeded("fetch quoted message", result);
    const message = result.data?.items?.[0];
    if (
      !message?.message_id ||
      !message.msg_type ||
      !message.sender?.sender_type ||
      message.body?.content === undefined
    ) {
      throw new Error(
        `Feishu returned no readable message for quoted message_id=${messageId}`,
      );
    }
    return {
      messageId: message.message_id,
      messageType: message.msg_type,
      senderType: message.sender.sender_type,
      senderId: message.sender.id,
      content: message.body.content,
      parentMessageId: message.parent_id,
    };
  }

  async function exercise(
    event: Parameters<
      NonNullable<Lark.EventHandles["im.message.receive_v1"]>
    >[0],
  ): Promise<void> {
    const { message, sender } = event;
    const messageId = message.message_id;
    await attempt("add OnIt reaction", () =>
      api.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "OnIt" } },
      }),
    );

    const triggerInput = await buildFeishuTriggerInput(
      {
        messageId,
        chatId: message.chat_id,
        chatType: message.chat_type,
        senderId: sender.sender_id?.open_id,
        senderType: sender.sender_type,
        messageType: message.message_type,
        content: message.content,
        parentMessageId: message.parent_id,
      },
      fetchMessage,
    );
    console.log(`[beacon] trigger input=${JSON.stringify(triggerInput)}`);

    await attempt("quoted final reply", () =>
      api.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: textContent(
            triggerInput.quotedMessages.length > 0
              ? `已记录当前消息及完整引用链（${triggerInput.quotedMessages.length} 条）；后续会一起交给 Agent Runtime。`
              : "已记录当前消息；本条消息没有引用上下文。",
          ),
          reply_in_thread: false,
        },
      }),
    );
  }

  const dispatcher = new Lark.EventDispatcher({
    loggerLevel: Lark.LoggerLevel.info,
  }).register({
    "im.message.receive_v1": async (event) => {
      const {
        chat_type: chatType,
        content,
        message_id: messageId,
      } = event.message;
      const parsed = JSON.parse(content) as { text?: unknown };
      console.log(
        `[beacon] received message event message_id=${messageId} chat_type=${chatType} content=${JSON.stringify(parsed)}`,
      );

      if (
        !shouldExerciseReplyExperiment(chatType, messageId, processedMessageIds)
      ) {
        console.log(
          `[beacon] ignored duplicate or unsupported event message_id=${messageId}`,
        );
        return;
      }
      processedMessageIds.add(messageId);

      void exercise(event).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[beacon] reply experiment failed: ${message}`);
        await attempt("quoted failure reply", () =>
          api.im.v1.message.reply({
            path: { message_id: messageId },
            data: {
              msg_type: "text",
              content: textContent(`处理失败：${message}`),
              reply_in_thread: false,
            },
          }),
        );
      });
    },
  });

  const ws = new Lark.WSClient({
    ...credentials,
    loggerLevel: Lark.LoggerLevel.info,
  });

  console.log(
    "[beacon] quoted-reply experiment ready; every new DM and group mention triggers one run",
  );
  await ws.start({ eventDispatcher: dispatcher });
}
