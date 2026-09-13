import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuCredentials } from "../config/secrets.js";
import type { FeishuMessageEvent } from "./intake.js";

type ShutdownSignalSource = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export function waitForShutdown(signals: ShutdownSignalSource = process): Promise<void> {
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

export async function runFeishuGateway(
  credentials: FeishuCredentials,
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
    ...credentials,
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
