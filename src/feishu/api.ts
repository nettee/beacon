import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuCredentials } from "../config/secrets.js";
import type { DeliveryAdapter } from "../run/orchestrator.js";
import type { FetchedMessage } from "./trigger-input.js";

type ApiResult = {
  code?: number | undefined;
  msg?: string | undefined;
  request_id?: string | undefined;
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

export class FeishuApi implements DeliveryAdapter {
  private readonly client: Lark.Client;

  constructor(credentials: FeishuCredentials) {
    this.client = new Lark.Client(credentials);
    this.credentials = credentials;
  }

  private readonly credentials: FeishuCredentials;

  async checkReady(): Promise<void> {
    const result = await this.client.auth.v3.tenantAccessToken.internal({
      data: {
        app_id: this.credentials.appId,
        app_secret: this.credentials.appSecret,
      },
    });
    assertSucceeded("obtain tenant access token", result);
    if (!result.data?.tenant_access_token) {
      throw new Error("Feishu readiness returned no tenant_access_token");
    }
  }

  async acknowledge(messageId: string): Promise<void> {
    const result = await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: "OnIt" } },
    });
    assertSucceeded("add OnIt reaction", result);
  }

  async fetchMessage(messageId: string): Promise<FetchedMessage> {
    const result = await this.client.im.v1.message.get({
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
        `Feishu returned no readable quoted message for message_id=${messageId}`,
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

  async deliver(
    target: Parameters<DeliveryAdapter["deliver"]>[0],
    text: string,
  ) {
    if (target.kind === "reply") {
      const result = await this.client.im.v1.message.reply({
        path: { message_id: target.messageId },
        data: {
          msg_type: "text",
          content: textContent(text),
          reply_in_thread: false,
        },
      });
      assertSucceeded("deliver quoted reply", result);
      return {};
    }
    if (target.kind === "chat") {
      const result = await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: target.chatId,
          msg_type: "text",
          content: textContent(text),
        },
      });
      assertSucceeded("deliver chat message", result);
      return {};
    }
    throw new Error("Feishu adapter cannot deliver to local stdout");
  }
}
