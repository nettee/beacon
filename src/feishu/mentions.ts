/**
 * Temporary hard cut: group @All must not start a Beacon run.
 * Prefer Feishu `message.mentions`; fall back to content placeholders.
 */

export type FeishuMention = {
  key?: string | undefined;
  id?:
    | {
        open_id?: string | undefined;
        user_id?: string | undefined;
        union_id?: string | undefined;
      }
    | undefined;
  name?: string | undefined;
  mentioned_type?: string | undefined;
};

export type FeishuMentionDecisionInput = {
  chatType: string;
  mentions?: FeishuMention[] | undefined;
  messageType?: string | undefined;
  content?: string | undefined;
};

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** True when a Feishu mention entry is @All / @所有人 / @_all. */
export function isFeishuAtAllMention(mention: FeishuMention): boolean {
  const key = normalize(mention.key);
  if (key === "@_all" || key === "@all") return true;

  const name = mention.name?.trim() ?? "";
  const nameLower = name.toLowerCase();
  if (name === "所有人" || nameLower === "all" || nameLower === "@all") {
    return true;
  }

  const userId = normalize(mention.id?.user_id);
  if (userId === "all" || userId === "@_all") return true;

  const openId = mention.id?.open_id?.trim() ?? "";
  const unionId = mention.id?.union_id?.trim() ?? "";
  // Empty-identity @_all-shaped rows sometimes omit a clean key.
  if (
    !openId &&
    !unionId &&
    !userId &&
    (key.includes("all") || name.includes("所有人"))
  ) {
    return true;
  }

  return false;
}

function walkForAtAll(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return (
      trimmed === "@_all" ||
      trimmed === "@all" ||
      trimmed === "all" ||
      /@_all\b/i.test(value)
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => walkForAtAll(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.tag === "at") {
      const userId = normalize(
        typeof record.user_id === "string" ? record.user_id : undefined,
      );
      if (userId === "all" || userId === "@_all") return true;
    }
    return Object.values(record).some((entry) => walkForAtAll(entry));
  }
  return false;
}

/** Detect @_all / at-all markers inside raw Feishu message content JSON. */
export function contentIndicatesFeishuAtAll(
  content: string | undefined,
): boolean {
  if (!content) return false;
  if (/@_all\b/i.test(content)) return true;
  try {
    return walkForAtAll(JSON.parse(content) as unknown);
  } catch {
    return /@_all\b/i.test(content);
  }
}

/**
 * A direct bot (or other entity) @mention — anything in `mentions` that is not @All.
 * With mention-only Feishu scopes, non-@All mentions are the bot itself.
 */
export function hasDirectFeishuMention(
  mentions: readonly FeishuMention[] | undefined,
): boolean {
  if (!mentions?.length) return false;
  return mentions.some((mention) => {
    if (isFeishuAtAllMention(mention)) return false;
    if (mention.mentioned_type === "bot") return true;
    // Explicit user @ is not a bot mention.
    if (mention.mentioned_type === "user") return false;
    const openId = mention.id?.open_id?.trim() ?? "";
    const userId = mention.id?.user_id?.trim() ?? "";
    const unionId = mention.id?.union_id?.trim() ?? "";
    // mentioned_type omitted: any non-@All identity counts (mention-only bots).
    return Boolean(openId || userId || unionId);
  });
}

/**
 * Beacon-layer gate for inbound Feishu events.
 * - DM (p2p): always process
 * - Group: process only when a non-@All mention is present
 * - Pure @All (with or without @_all content): ignore
 * - @All + @bot together: process (direct mention wins)
 */
export function shouldProcessFeishuInbound(
  input: FeishuMentionDecisionInput,
): boolean {
  if (input.chatType === "p2p") return true;
  if (input.chatType !== "group") return false;
  return hasDirectFeishuMention(input.mentions);
}
