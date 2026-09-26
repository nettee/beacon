import assert from "node:assert/strict";
import test from "node:test";

import {
  feedbackFromToolParams,
  noReplyFromToolParams,
  notifyCardFromToolParams,
  replyCardFromToolParams,
  replyFromToolParams,
} from "./pi-outcome-extension.js";

test("maps the reply tool parameters to a text reply", () => {
  assert.deepEqual(replyFromToolParams({ text: "done" }), {
    reply: { kind: "text", text: "done" },
  });
});

test("maps the reply_card tool parameters to a card reply", () => {
  assert.deepEqual(
    replyCardFromToolParams({ title: "Report", content: "- done" }),
    {
      reply: {
        kind: "card",
        title: "Report",
        content: "- done",
        buttons: [],
      },
    },
  );
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

test("maps submit_feedback parameters to a feedback patch", () => {
  assert.deepEqual(
    feedbackFromToolParams({
      items: [
        {
          priority: "high",
          summary: "GRAFANA_READER_TOKEN_PROD is unset.",
        },
      ],
    }),
    {
      items: [
        {
          priority: "high",
          summary: "GRAFANA_READER_TOKEN_PROD is unset.",
        },
      ],
    },
  );
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
  assert.throws(
    () =>
      feedbackFromToolParams({
        items: [
          {
            priority: "low" as "high",
            summary: "too noisy",
          },
        ],
      }),
    /invalid_value|priority/,
  );
  assert.throws(() => feedbackFromToolParams({ items: [] }), /too_small|min/);
  assert.throws(
    () =>
      feedbackFromToolParams({
        items: [
          { priority: "high", summary: "a" },
          { priority: "medium", summary: "b" },
          { priority: "medium", summary: "c" },
          { priority: "high", summary: "d" },
        ],
      }),
    /too_big|max/,
  );
});
