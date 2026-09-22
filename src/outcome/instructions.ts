export const inboundOutOfRoleReply = "这条消息不在我的职责范围内。";

export const finalOutcomeContractInstructions = [
  "`reply` sends plain text. For an inbound Feishu message, quote-reply that message. For a Schedule, message the Profile admin. For a manual Run, print to the operator. Do not fill `chat_id`.",
  "`no_reply` finishes a Run without messaging anyone. Its reason is stored for audit and is never sent.",
  "`notify_card` posts a titled Markdown card to the Schedule's configured notify group. Do not fill `chat_id`.",
  "Beacon ignores ordinary assistant final text for Delivery.",
] as const;

export const feedbackContractInstructions = [
  "After the task, call `submit_feedback` exactly once before this process exits. You may call it before or after `reply` / `no_reply`.",
  "Report only high or medium problems with instructions, Skills, dependencies, or tools that actually existed on this Run. If there are none, submit `items: []`. Do not invent items to fill three slots.",
  "Do not report low-priority issues, taste, or problems you already worked around without needing a platform change.",
] as const;
