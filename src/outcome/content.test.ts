import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFinalOutcomeContent,
  renderFinalOutcomeAsText,
} from "./content.js";

test("accepts text, no-reply, and card Final Outcomes", () => {
  assert.deepEqual(parseFinalOutcomeContent({ kind: "text", text: "done" }), {
    kind: "text",
    text: "done",
  });
  assert.deepEqual(
    parseFinalOutcomeContent({ kind: "no_reply", reason: "not my role" }),
    { kind: "no_reply", reason: "not my role" },
  );
  assert.deepEqual(
    parseFinalOutcomeContent({
      kind: "card",
      title: "Report",
      content: "- item",
    }),
    { kind: "card", title: "Report", content: "- item", buttons: [] },
  );
});

test("rejects ambiguous or unsafe card content", () => {
  assert.throws(
    () => parseFinalOutcomeContent({ kind: "no_reply", reason: " " }),
    /must not be blank/,
  );
  assert.throws(
    () => parseFinalOutcomeContent({ kind: "text", text: " " }),
    /must not be blank/,
  );
  assert.throws(
    () =>
      parseFinalOutcomeContent({
        kind: "card",
        title: "Report",
        content: "done",
        buttons: [{ label: "Open", url: "javascript:alert(1)" }],
      }),
    /http or https/,
  );
});

test("renders a card as readable Markdown for local stdout", () => {
  assert.equal(
    renderFinalOutcomeAsText({
      kind: "card",
      title: "Report",
      content: "- item",
      buttons: [{ label: "Open", url: "https://example.com" }],
    }),
    "# Report\n\n- item\n\n[Open](https://example.com)",
  );
});

test("renders a no-reply Outcome without user-facing text", () => {
  assert.equal(
    renderFinalOutcomeAsText({ kind: "no_reply", reason: "not my role" }),
    "",
  );
});
