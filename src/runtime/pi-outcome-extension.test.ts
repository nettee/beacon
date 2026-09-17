import assert from "node:assert/strict";
import test from "node:test";

import {
  cardOutcomeFromToolParams,
  noReplyOutcomeFromToolParams,
  textOutcomeFromToolParams,
} from "./pi-outcome-extension.js";

test("maps the text tool parameters to a text Final Outcome", () => {
  assert.deepEqual(textOutcomeFromToolParams({ text: "done" }), {
    kind: "text",
    text: "done",
  });
});

test("maps the card tool parameters to a card Final Outcome", () => {
  assert.deepEqual(
    cardOutcomeFromToolParams({ title: "Report", content: "- done" }),
    { kind: "card", title: "Report", content: "- done", buttons: [] },
  );
});

test("maps the no-reply tool parameters to a no-reply Final Outcome", () => {
  assert.deepEqual(noReplyOutcomeFromToolParams({ reason: "not my role" }), {
    kind: "no_reply",
    reason: "not my role",
  });
});

test("both tools reject invalid content at the runtime boundary", () => {
  assert.throws(
    () => noReplyOutcomeFromToolParams({ reason: " " }),
    /must not be blank/,
  );
  assert.throws(
    () => textOutcomeFromToolParams({ text: " " }),
    /must not be blank/,
  );
  assert.throws(
    () =>
      cardOutcomeFromToolParams({
        title: "Report",
        content: "done",
        buttons: [{ label: "Open", url: "javascript:alert(1)" }],
      }),
    /http or https/,
  );
});
