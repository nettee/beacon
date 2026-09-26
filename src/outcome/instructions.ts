export const inboundOutOfRoleReply = "这条消息不在我的职责范围内。";

export const finalOutcomeContractInstructions = [
  "`reply` sends plain text. For an inbound Feishu message, quote-reply that message. For a Schedule, message the Profile admin. For a manual Run, print to the operator. Do not fill `chat_id`.",
  "`no_reply` finishes a Run without messaging anyone. Its reason is stored for audit and is never sent. On inbound Feishu Runs, call it only together with `notify_card` (the card is the user-facing reply).",
  "`notify_card` posts a titled Markdown card. On a Schedule with a notify group, it goes to that group. On an inbound Feishu message, it quote-replies the user as an interactive card; call `no_reply` on the same Run instead of a text `reply`. Do not fill `chat_id`.",
  "Beacon ignores ordinary assistant final text for Delivery.",
] as const;

export const feedbackContractInstructions = [
  "If this Run had a real high or medium problem with instructions, Skills, dependencies, or tools, you may call `submit_feedback` once with one to three items.",
  "If there are none, do not call it. Do not invent items. Do not report low-priority issues, taste, or problems you already worked around without needing a platform change.",
] as const;
