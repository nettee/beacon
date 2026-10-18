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
  /** Full Feishu topic/thread timeline (oldest first), excluding current_message. */
  threadMessages: MessageSnapshot[];
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
  rootMessageId?: string | undefined;
  threadId?: string | undefined;
};

export type FetchedMessage = {
  messageId: string;
  messageType: string;
  senderType: string;
  senderId?: string | undefined;
  content: string;
  parentMessageId?: string | undefined;
  rootMessageId?: string | undefined;
  threadId?: string | undefined;
};

/** Topics are usually short; stop after this many prior messages. */
export const MAX_THREAD_MESSAGES = 100;

function parseContent(messageId: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Message ${messageId} has invalid JSON content`, {
      cause: error,
    });
  }
}

function toSnapshot(message: FetchedMessage): MessageSnapshot {
  return {
    messageId: message.messageId,
    messageType: message.messageType,
    senderType: message.senderType,
    senderId: message.senderId,
    content: parseContent(message.messageId, message.content),
  };
}

export type BuildFeishuTriggerInputDeps = {
  fetchMessage: (messageId: string) => Promise<FetchedMessage>;
  listThreadMessages: (threadId: string) => Promise<FetchedMessage[]>;
};

async function resolveThreadId(
  inbound: InboundMessage,
  fetchMessage: (messageId: string) => Promise<FetchedMessage>,
  quoted: readonly FetchedMessage[],
): Promise<string | undefined> {
  if (inbound.threadId) return inbound.threadId;
  for (const message of quoted) {
    if (message.threadId) return message.threadId;
  }
  const probeId = inbound.rootMessageId ?? inbound.parentMessageId;
  if (!probeId) return undefined;
  // Parent/root may already be in the quoted chain above; otherwise fetch once.
  if (quoted.some((message) => message.messageId === probeId)) {
    return undefined;
  }
  const probed = await fetchMessage(probeId);
  return probed.threadId;
}

export async function buildFeishuTriggerInput(
  inbound: InboundMessage,
  deps: BuildFeishuTriggerInputDeps,
): Promise<FeishuTriggerInput> {
  const reverseQuoted: FetchedMessage[] = [];
  const seenMessageIds = new Set([inbound.messageId]);
  let parentMessageId = inbound.parentMessageId;

  while (parentMessageId) {
    if (seenMessageIds.has(parentMessageId)) {
      throw new Error(
        `Quoted message chain contains a cycle at message ${parentMessageId}`,
      );
    }
    seenMessageIds.add(parentMessageId);

    const quoted = await deps.fetchMessage(parentMessageId);
    reverseQuoted.push(quoted);
    parentMessageId = quoted.parentMessageId;
  }

  const quotedFetched = reverseQuoted.reverse();
  const threadId = await resolveThreadId(
    inbound,
    deps.fetchMessage,
    quotedFetched,
  );

  let threadMessages: MessageSnapshot[] = [];
  if (threadId) {
    const threadFetched = await deps.listThreadMessages(threadId);
    threadMessages = threadFetched
      .filter((message) => message.messageId !== inbound.messageId)
      .slice(0, MAX_THREAD_MESSAGES)
      .map(toSnapshot);
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
    quotedMessages: quotedFetched.map(toSnapshot),
    threadMessages,
  };
}
