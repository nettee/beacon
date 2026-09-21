import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFinalOutcomeContent,
  parseOutcomePatch,
  renderFinalOutcomeAsText,
} from "./content.js";

test("accepts reply, no-reply, and notify card Outcomes", () => {
  assert.deepEqual(
    parseFinalOutcomeContent({ reply: { kind: "text", text: "done" } }),
    { reply: { kind: "text", text: "done" } },
  );
  assert.deepEqual(
    parseFinalOutcomeContent({
      reply: { kind: "no_reply", reason: "not my role" },
    }),
    { reply: { kind: "no_reply", reason: "not my role" } },
  );
  assert.deepEqual(
    parseFinalOutcomeContent({
      reply: { kind: "no_reply", reason: "announced" },
      notify: { kind: "card", title: "Report", content: "- item" },
    }),
    {
      reply: { kind: "no_reply", reason: "announced" },
      notify: { kind: "card", title: "Report", content: "- item", buttons: [] },
    },
  );
});

test("maps legacy kind unions into reply/notify", () => {
  assert.deepEqual(parseOutcomePatch({ kind: "text", text: "done" }), {
    reply: { kind: "text", text: "done" },
  });
  assert.deepEqual(
    parseFinalOutcomeContent({ kind: "no_reply", reason: "not my role" }),
    { reply: { kind: "no_reply", reason: "not my role" } },
  );
});

test("rejects ambiguous or unsafe card content", () => {
  assert.throws(
    () =>
      parseFinalOutcomeContent({
        reply: { kind: "no_reply", reason: " " },
      }),
    /must not be blank/,
  );
  assert.throws(
    () => parseFinalOutcomeContent({ reply: { kind: "text", text: " " } }),
    /must not be blank/,
  );
  assert.throws(
    () =>
      parseFinalOutcomeContent({
        reply: { kind: "no_reply", reason: "announced" },
        notify: {
          kind: "card",
          title: "Report",
          content: "done",
          buttons: [{ label: "Open", url: "javascript:alert(1)" }],
        },
      }),
    /http or https/,
  );
});

test("renders a notify card as readable Markdown for local stdout", () => {
  assert.equal(
    renderFinalOutcomeAsText({
      reply: { kind: "no_reply", reason: "announced" },
      notify: {
        kind: "card",
        title: "Report",
        content: "- item",
        buttons: [{ label: "Open", url: "https://example.com" }],
      },
    }),
    "# Report\n\n- item\n\n[Open](https://example.com)",
  );
});

test("renders a no-reply Outcome without user-facing text", () => {
  assert.equal(
    renderFinalOutcomeAsText({
      reply: { kind: "no_reply", reason: "not my role" },
    }),
    "",
  );
});
