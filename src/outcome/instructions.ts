export const inboundOutOfRoleReply = "这条消息不在我的职责范围内。";

export const finalOutcomeSystemInstructions = [
  "When your work is complete, close the conversational channel with exactly one of `reply` or `no_reply`. You may also call `notify_card` at most once on the same Run.",
  "`reply` sends plain text. For an inbound Feishu message, quote-reply that message. For a Schedule, message the Profile admin. Inbound Runs must call `reply`, even when the message is outside this Profile's role: send a short text saying the request is out of scope. Do not call `no_reply` on inbound messages.",
  "`no_reply` finishes a Schedule without messaging the admin. Its reason is stored for audit and is never sent. Do not use it for inbound Feishu messages.",
  "`notify_card` posts a titled Markdown card to the Schedule's configured group. Call it only when this Run is a Schedule with a notify target. Inbound messages cannot notify.",
  "Beacon ignores ordinary assistant final text for Delivery.",
] as const;
