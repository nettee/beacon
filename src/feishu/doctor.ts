import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuCredentials } from "../config/secrets.js";

export async function runFeishuDoctor(credentials: FeishuCredentials): Promise<void> {
  const dispatcher = new Lark.EventDispatcher({
    loggerLevel: Lark.LoggerLevel.info,
  }).register({
    "im.message.receive_v1": async (event) => {
      const messageId = event.message.message_id;
      const chatType = event.message.chat_type;
      const content = JSON.parse(event.message.content) as unknown;
      console.log(`[beacon] received message event message_id=${messageId} chat_type=${chatType}`);
      console.log(`[beacon] message content=${JSON.stringify(content)}`);
    },
  });

  const client = new Lark.WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  console.log("[beacon] starting Feishu long connection; press Ctrl-C to stop");
  await client.start({ eventDispatcher: dispatcher });
}
