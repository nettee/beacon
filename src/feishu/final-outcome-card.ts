import type { FinalOutcomeContent } from "../domain/types.js";

type CardOutcome = Extract<FinalOutcomeContent, { kind: "card" }>;

export type FeishuFinalOutcomeCard = {
  config: {
    wide_screen_mode: true;
  };
  header: {
    template: "blue";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  elements: object[];
};

function formatTimestamp(date: Date, timeZone?: string): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Final Outcome card timestamp must be a valid Date");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`Missing ${type} in formatted card timestamp`);
    return part;
  };
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

export function buildFeishuFinalOutcomeCard(
  outcome: CardOutcome,
  options: { generatedAt?: Date; timeZone?: string } = {},
): FeishuFinalOutcomeCard {
  const elements: object[] = [{ tag: "markdown", content: outcome.content }];

  if (outcome.buttons.length > 0) {
    elements.push(
      { tag: "hr" },
      {
        tag: "action",
        actions: outcome.buttons.map((button, index) => ({
          tag: "button",
          text: { tag: "plain_text", content: button.label },
          url: button.url,
          type: index === 0 ? "primary" : "default",
        })),
      },
    );
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `卡片生成时间：${formatTimestamp(options.generatedAt ?? new Date(), options.timeZone)}`,
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: outcome.title },
    },
    elements,
  };
}
