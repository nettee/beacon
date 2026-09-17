export const finalOutcomeSystemInstructions = [
  "When your work is complete, call exactly one of submit_final_outcome_text, submit_final_outcome_card, or submit_final_outcome_no_reply.",
  "Use submit_final_outcome_text for a normal response, submit_final_outcome_card when a titled Markdown summary and link buttons materially improve the result, or submit_final_outcome_no_reply when the triggering message is outside the Profile's role and should receive no response.",
  "Beacon ignores ordinary assistant final text for Delivery.",
] as const;
