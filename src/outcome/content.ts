import { z } from "zod";

import type {
  CardContent,
  DeliveryContent,
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
  })
  .strict()
  .refine((value) => value.reply !== undefined || value.notify !== undefined, {
    message: "Outcome submission must include reply or notify",
  });

const legacyOutcomeSchema = z.discriminatedUnion("kind", [
  textReplySchema,
  noReplySchema,
  cardSchema,
]);

export type OutcomePatch = {
  reply?: ReplyContent | undefined;
  notify?: CardContent | undefined;
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
  return {
    ...(current?.reply || patch.reply
      ? { reply: patch.reply ?? current?.reply }
      : {}),
    ...(current?.notify || patch.notify
      ? { notify: patch.notify ?? current?.notify }
      : {}),
  };
}

export function completeOutcome(partial: OutcomePatch): FinalOutcomeContent {
  if (!partial.reply) {
    throw new Error(
      "Agent Runtime settled without submitting reply or no_reply",
    );
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
