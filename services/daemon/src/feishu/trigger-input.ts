export type MessageSnapshot = {
  messageId: string;
  messageType: string;
  senderType: string;
  senderId?: string | undefined;
  content: unknown;
};

export type FeishuTriggerInput = {
  source: {
    messageId: string;
    chatId: string;
    chatType: string;
    senderId?: string | undefined;
  };
  message: MessageSnapshot;
  quotedMessages: MessageSnapshot[];
};

export type InboundMessage = {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId?: string | undefined;
  senderType: string;
  messageType: string;
  content: string;
  parentMessageId?: string | undefined;
};

export type FetchedMessage = {
  messageId: string;
  messageType: string;
  senderType: string;
  senderId?: string | undefined;
  content: string;
  parentMessageId?: string | undefined;
};

function parseContent(messageId: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Message ${messageId} has invalid JSON content`, {
      cause: error,
    });
  }
}

export async function buildFeishuTriggerInput(
  inbound: InboundMessage,
  fetchMessage: (messageId: string) => Promise<FetchedMessage>,
): Promise<FeishuTriggerInput> {
  const reverseQuotedMessages: MessageSnapshot[] = [];
  const seenMessageIds = new Set([inbound.messageId]);
  let parentMessageId = inbound.parentMessageId;

  while (parentMessageId) {
    if (seenMessageIds.has(parentMessageId)) {
      throw new Error(
        `Quoted message chain contains a cycle at message ${parentMessageId}`,
      );
    }
    seenMessageIds.add(parentMessageId);

    const quoted = await fetchMessage(parentMessageId);
    reverseQuotedMessages.push({
      messageId: quoted.messageId,
      messageType: quoted.messageType,
      senderType: quoted.senderType,
      senderId: quoted.senderId,
      content: parseContent(quoted.messageId, quoted.content),
    });
    parentMessageId = quoted.parentMessageId;
  }

  return {
    source: {
      messageId: inbound.messageId,
      chatId: inbound.chatId,
      chatType: inbound.chatType,
      senderId: inbound.senderId,
    },
    message: {
      messageId: inbound.messageId,
      messageType: inbound.messageType,
      senderType: inbound.senderType,
      senderId: inbound.senderId,
      content: parseContent(inbound.messageId, inbound.content),
    },
    quotedMessages: reverseQuotedMessages.reverse(),
  };
}
