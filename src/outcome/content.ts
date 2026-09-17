import { z } from "zod";

import type { FinalOutcomeContent } from "../domain/types.js";

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

export const finalOutcomeContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: nonBlank }).strict(),
  z.object({ kind: z.literal("no_reply"), reason: nonBlank }).strict(),
  z
    .object({
      kind: z.literal("card"),
      title: nonBlank,
      content: nonBlank,
      buttons: z.array(buttonSchema).max(5).default([]),
    })
    .strict(),
]);

export function parseFinalOutcomeContent(value: unknown): FinalOutcomeContent {
  return finalOutcomeContentSchema.parse(value);
}

export function renderFinalOutcomeAsText(outcome: FinalOutcomeContent): string {
  if (outcome.kind === "text") return outcome.text;
  if (outcome.kind === "no_reply") return "";
  return [
    `# ${outcome.title}`,
    "",
    outcome.content,
    ...outcome.buttons.map((button) => `\n[${button.label}](${button.url})`),
  ].join("\n");
}
