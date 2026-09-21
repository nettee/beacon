import assert from "node:assert/strict";
import test from "node:test";

import {
  noReplyFromToolParams,
  notifyCardFromToolParams,
  replyFromToolParams,
} from "./pi-outcome-extension.js";

test("maps the reply tool parameters to a text reply", () => {
  assert.deepEqual(replyFromToolParams({ text: "done" }), {
    reply: { kind: "text", text: "done" },
  });
});

test("maps the notify_card tool parameters to a card", () => {
  assert.deepEqual(
    notifyCardFromToolParams({ title: "Report", content: "- done" }),
    { kind: "card", title: "Report", content: "- done", buttons: [] },
  );
});

test("maps the no_reply tool parameters to a silent reply", () => {
  assert.deepEqual(noReplyFromToolParams({ reason: "not my role" }), {
    reply: { kind: "no_reply", reason: "not my role" },
  });
});

test("tools reject invalid content at the runtime boundary", () => {
  assert.throws(
    () => noReplyFromToolParams({ reason: " " }),
    /must not be blank/,
  );
  assert.throws(() => replyFromToolParams({ text: " " }), /must not be blank/);
  assert.throws(
    () =>
      notifyCardFromToolParams({
        title: "Report",
        content: "done",
        buttons: [{ label: "Open", url: "javascript:alert(1)" }],
      }),
    /http or https/,
  );
});
