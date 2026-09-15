export const finalOutcomeSystemInstructions = [
  "When your work is complete, call exactly one of submit_final_outcome_text or submit_final_outcome_card with the exact user-facing response.",
  "Use submit_final_outcome_text for a normal response, or submit_final_outcome_card when a titled Markdown summary and link buttons materially improve the result.",
  "Beacon ignores ordinary assistant final text for Delivery.",
] as const;
