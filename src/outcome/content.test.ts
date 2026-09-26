import assert from "node:assert/strict";
import test from "node:test";

import {
  completeOutcome,
  isMissingReplyOutcomeError,
  MISSING_REPLY_OUTCOME_SUMMARY,
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

test("renders a reply card as readable Markdown for local stdout", () => {
  assert.equal(
    renderFinalOutcomeAsText({
      reply: {
        kind: "card",
        title: "Report",
        content: "- item",
        buttons: [{ label: "Open", url: "https://example.com" }],
      },
    }),
    "# Report\n\n- item\n\n[Open](https://example.com)",
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

test("completeOutcome requires reply or no_reply with a clear summary", () => {
  assert.throws(
    () => completeOutcome({}),
    (error: unknown) =>
      error instanceof Error &&
      error.message === MISSING_REPLY_OUTCOME_SUMMARY &&
      isMissingReplyOutcomeError(error),
  );
  assert.throws(
    () =>
      completeOutcome({
        notify: { kind: "card", title: "Report", content: "- item" },
      }),
    (error: unknown) => isMissingReplyOutcomeError(error),
  );
  assert.ok(
    isMissingReplyOutcomeError(
      new Error("Agent Runtime settled without submitting reply or no_reply"),
    ),
  );
});

test("accepts a feedback-only patch with one to three items", () => {
  assert.throws(
    () => parseOutcomePatch({ feedback: { items: [] } }),
    /too_small|min/,
  );
  assert.deepEqual(
    parseOutcomePatch({
      feedback: {
        items: [
          {
            priority: "medium",
            summary: "persona.md never says when to stop.",
          },
        ],
      },
    }),
    {
      feedback: {
        items: [
          {
            priority: "medium",
            summary: "persona.md never says when to stop.",
          },
        ],
      },
    },
  );
});

test("rejects feedback that is too long, low priority, or missing fields", () => {
  assert.throws(
    () =>
      parseOutcomePatch({
        feedback: {
          items: [
            {
              priority: "low",
              summary: "nits",
            },
          ],
        },
      }),
    /invalid_value|priority/,
  );
  assert.throws(
    () => parseOutcomePatch({ feedback: { items: [{ priority: "high" }] } }),
    /required|summary/,
  );
  assert.throws(
    () =>
      parseOutcomePatch({
        feedback: {
          items: [
            { priority: "high", summary: "a" },
            { priority: "high", summary: "b" },
            { priority: "medium", summary: "c" },
            { priority: "medium", summary: "d" },
          ],
        },
      }),
    /too_big|max/,
  );
});
