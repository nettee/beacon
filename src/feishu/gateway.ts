import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuCredentials } from "../config/secrets.js";
import type { DeliveryAdapter } from "../run/orchestrator.js";
import type { FeishuMessageEvent } from "./intake.js";
import type { FeishuMessageGateway } from "./message-gateway.js";
import type { FetchedMessage } from "./trigger-input.js";

type ApiResult = {
  code?: number | undefined;
  msg?: string | undefined;
  request_id?: string | undefined;
};

type TenantAccessTokenResult = ApiResult & {
  tenant_access_token?: string | undefined;
};

type ShutdownSignalSource = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export function waitForShutdown(
  signals: ShutdownSignalSource = process,
): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = (): void => {
      signals.off("SIGINT", shutdown);
      signals.off("SIGTERM", shutdown);
      resolve();
    };
    signals.once("SIGINT", shutdown);
    signals.once("SIGTERM", shutdown);
  });
}

export function shouldAcceptFeishuMessage(
  chatType: string,
  senderType: string,
  messageId: string,
  processedMessageIds: ReadonlySet<string>,
): boolean {
  return (
    (chatType === "p2p" || chatType === "group") &&
    senderType === "user" &&
    !processedMessageIds.has(messageId)
  );
}

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

export class FeishuGateway implements FeishuMessageGateway {
  private readonly client: Lark.Client;

  constructor(private readonly credentials: FeishuCredentials) {
    this.client = new Lark.Client(credentials);
  }

  async checkReady(): Promise<void> {
    const result = (await this.client.auth.v3.tenantAccessToken.internal({
      data: {
        app_id: this.credentials.appId,
        app_secret: this.credentials.appSecret,
      },
    })) as TenantAccessTokenResult;
    assertSucceeded("obtain tenant access token", result);
    if (!result.tenant_access_token) {
      throw new Error("Feishu readiness returned no tenant_access_token");
    }
  }

  async run(
    handleEvent: (event: FeishuMessageEvent) => Promise<unknown>,
    shutdown: Promise<void> = waitForShutdown(),
  ): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.info,
    }).register({
      "im.message.receive_v1": async (event) => {
        await handleEvent(event);
      },
    });

    let rejectTerminalFailure: (error: Error) => void = () => undefined;
    const terminalFailure = new Promise<never>((_resolve, reject) => {
      rejectTerminalFailure = reject;
    });
    const ws = new Lark.WSClient({
      ...this.credentials,
      loggerLevel: Lark.LoggerLevel.info,
      onError: (error) => rejectTerminalFailure(error),
    });
    console.log("[beacon] Feishu Gateway ready");
    try {
      await ws.start({ eventDispatcher: dispatcher });
      await Promise.race([shutdown, terminalFailure]);
    } finally {
      ws.close({ force: true });
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
    throw new Error("Feishu Gateway cannot deliver to local stdout");
  }
}

export function createFeishuGateway(
  credentials: FeishuCredentials,
): FeishuGateway {
  return new FeishuGateway(credentials);
}
