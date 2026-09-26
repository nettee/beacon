export const inboundOutOfRoleReply = "这条消息不在我的职责范围内。";

export const finalOutcomeContractInstructions = [
  "`reply_text` sends plain text. For an inbound Feishu message, quote-reply that message. For a Schedule, message the Profile admin. For a manual Run, print to the operator. Do not fill `chat_id`.",
  "`reply_card` sends a titled Markdown card on the conversational channel (inbound quote-reply, or Schedule admin chat). It closes that channel by itself. Do not also call `reply_text` or `no_reply` on the same Run. Do not fill `chat_id`.",
  "`no_reply` finishes a Run without messaging the conversational channel. Its reason is stored for audit and is never sent. Do not use it on inbound Feishu messages.",
  "`notify_card` posts a titled Markdown card to the Schedule's configured notify group. Call it only when this Run has a notify target. Do not fill `chat_id`.",
  "Which tool to use for a given business result is decided by the Profile persona/task (or the situation), not by these platform lines alone.",
  "Beacon ignores ordinary assistant final text for Delivery.",
] as const;

export const feedbackContractInstructions = [
  "If this Run had a real high or medium problem with instructions, Skills, dependencies, or tools, you may call `submit_feedback` once with one to three items.",
  "If there are none, do not call it. Do not invent items. Do not report low-priority issues, taste, or problems you already worked around without needing a platform change.",
] as const;
