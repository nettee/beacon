import { z } from "zod";

import type {
  CardContent,
  DeliveryContent,
  FeedbackContent,
  FinalOutcomeContent,
  ReplyContent,
} from "../domain/types.js";

const nonBlank = z.string().refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});

const buttonSchema = z
  .object({
    label: nonBlank,
    url: z
      .url()
      .refine(
        (value) => value.startsWith("https://") || value.startsWith("http://"),
        "must use http or https",
      ),
  })
  .strict();

const textReplySchema = z
  .object({ kind: z.literal("text"), text: nonBlank })
  .strict();
const noReplySchema = z
  .object({ kind: z.literal("no_reply"), reason: nonBlank })
  .strict();
const replySchema = z.discriminatedUnion("kind", [
  textReplySchema,
  noReplySchema,
]);
const cardSchema = z
  .object({
    kind: z.literal("card"),
    title: nonBlank,
    content: nonBlank,
    buttons: z.array(buttonSchema).max(5).default([]),
  })
  .strict();

export const feedbackItemSchema = z
  .object({
    priority: z.enum(["high", "medium"]),
    summary: nonBlank.max(1024),
  })
  .strict();

export const feedbackContentSchema = z
  .object({
    items: z.array(feedbackItemSchema).min(1).max(3),
  })
  .strict();

export const feedbackRecordSchema = z
  .object({
    items: z.array(feedbackItemSchema).min(1).max(3),
    submittedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const finalOutcomeContentSchema = z
  .object({
    reply: replySchema,
    notify: cardSchema.optional(),
  })
  .strict();

const outcomePatchSchema = z
  .object({
    reply: replySchema.optional(),
    notify: cardSchema.optional(),
    feedback: feedbackContentSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.reply !== undefined ||
      value.notify !== undefined ||
      value.feedback !== undefined,
    {
      message: "Outcome submission must include reply, notify, or feedback",
    },
  );

const legacyOutcomeSchema = z.discriminatedUnion("kind", [
  textReplySchema,
  noReplySchema,
  cardSchema,
]);

export type OutcomePatch = {
  reply?: ReplyContent | undefined;
  notify?: CardContent | undefined;
  feedback?: FeedbackContent | undefined;
};

function renderCard(card: CardContent): string {
  return [
    `# ${card.title}`,
    "",
    card.content,
    ...card.buttons.map((button) => `\n[${button.label}](${button.url})`),
  ].join("\n");
}

export function parseFinalOutcomeContent(value: unknown): FinalOutcomeContent {
  const legacy = legacyOutcomeSchema.safeParse(value);
  if (legacy.success) {
    if (legacy.data.kind === "card") {
      return {
        reply: { kind: "text", text: renderCard(legacy.data) },
        notify: legacy.data,
      };
    }
    return { reply: legacy.data };
  }
  return finalOutcomeContentSchema.parse(value);
}

export function parseOutcomePatch(value: unknown): OutcomePatch {
  const legacy = legacyOutcomeSchema.safeParse(value);
  if (legacy.success) return parseFinalOutcomeContent(legacy.data);
  return outcomePatchSchema.parse(value);
}

export function mergeOutcome(
  current: OutcomePatch | undefined,
  patch: OutcomePatch,
): OutcomePatch {
  if (patch.reply && current?.reply) {
    throw new Error("Reply already submitted");
  }
  if (patch.notify && current?.notify) {
    throw new Error("Notify already submitted");
  }
  if (patch.feedback && current?.feedback) {
    throw new Error("Feedback already submitted");
  }
  return {
    ...(current?.reply || patch.reply
      ? { reply: patch.reply ?? current?.reply }
      : {}),
    ...(current?.notify || patch.notify
      ? { notify: patch.notify ?? current?.notify }
      : {}),
    ...(current?.feedback || patch.feedback
      ? { feedback: patch.feedback ?? current?.feedback }
      : {}),
  };
}

/** Stable English summary when the Agent settles without closing reply/no_reply. */
export const MISSING_REPLY_OUTCOME_SUMMARY =
  "Expected exactly one of `reply` or `no_reply`, but the Agent Runtime settled without submitting either";

export function isMissingReplyOutcomeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === MISSING_REPLY_OUTCOME_SUMMARY) return true;
  // Legacy summaries from earlier Beacon builds
  return (
    /settled without submitting reply or no_reply/i.test(error.message) ||
    /submitting a (Final Outcome|reply or no_reply)/i.test(error.message)
  );
}

export function completeOutcome(partial: OutcomePatch): FinalOutcomeContent {
  if (!partial.reply) {
    throw new Error(MISSING_REPLY_OUTCOME_SUMMARY);
  }
  return {
    reply: partial.reply,
    ...(partial.notify ? { notify: partial.notify } : {}),
  };
}

export function renderFinalOutcomeAsText(outcome: FinalOutcomeContent): string {
  const parts: string[] = [];
  if (outcome.reply.kind === "text") parts.push(outcome.reply.text);
  if (outcome.notify) parts.push(renderCard(outcome.notify));
  return parts.join("\n\n");
}

export function renderDeliveryAsText(content: DeliveryContent): string {
  if (content.kind === "text") return content.text;
  return renderCard(content);
}
