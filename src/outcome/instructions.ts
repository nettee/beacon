export const inboundOutOfRoleReply = "这条消息不在我的职责范围内。";

export const finalOutcomeContractInstructions = [
  "`reply` sends plain text. For an inbound Feishu message, quote-reply that message. For a Schedule, message the Profile admin. For a manual Run, print to the operator. Do not fill `chat_id`.",
  "`no_reply` finishes a Run without messaging anyone. Its reason is stored for audit and is never sent.",
  "`notify_card` posts a titled Markdown card to the Schedule's configured notify group. Do not fill `chat_id`.",
  "Beacon ignores ordinary assistant final text for Delivery.",
] as const;
