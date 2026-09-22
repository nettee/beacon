import assert from "node:assert/strict";
import test from "node:test";

import {
  fillExportedHtmlFeedback,
  htmlFeedbackView,
  renderFeedbackMarkup,
} from "./session-feedback.js";

function sessionHtml(data: unknown): string {
  const encoded = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  return `<!doctype html><body><script id="session-data" type="application/json">${encoded}</script></body>`;
}

function decodeSession(html: string): unknown {
  const match = /id="session-data"[^>]*>([^<]*)<\/script>/.exec(html);
  assert.ok(match?.[1]);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

test("hides Feedback when the Run record has no field", () => {
  assert.deepEqual(htmlFeedbackView(undefined), { status: "hidden" });
  const original = sessionHtml({ header: { id: "run_old" } });
  assert.equal(fillExportedHtmlFeedback(original, undefined), original);
});

test("fills 未提交 when this Run expected feedback and none arrived", () => {
  const html = fillExportedHtmlFeedback(
    sessionHtml({ header: { id: "run_ok" }, systemPrompt: "prompt" }),
    null,
  );
  const data = decodeSession(html) as { beaconFeedback?: { status: string } };
  assert.equal(data.beaconFeedback?.status, "missing");
  assert.match(html, /data-beacon-feedback="missing"/);
  assert.match(html, />未提交</);
  assert.match(html, />Feedback</);
});

test("fills 无问题 when the Agent submitted an empty list", () => {
  const html = fillExportedHtmlFeedback(
    sessionHtml({ header: { id: "run_ok" } }),
    {
      items: [],
      submittedAt: "2026-09-22T02:00:00.000Z",
    },
  );
  const data = decodeSession(html) as { beaconFeedback?: { status: string } };
  assert.equal(data.beaconFeedback?.status, "empty");
  assert.match(html, />无问题</);
  assert.doesNotMatch(html, /未提交/);
});

test("fills priority, category, and summary for submitted items", () => {
  const html = fillExportedHtmlFeedback(
    sessionHtml({ header: { id: "run_ok" } }),
    {
      items: [
        {
          priority: "high",
          category: "dependency",
          summary: "GRAFANA_READER_TOKEN_PROD is unset.",
        },
        {
          priority: "medium",
          category: "instructions",
          summary: "task.md never says to call no_reply on empty hours.",
        },
      ],
      submittedAt: "2026-09-22T02:00:00.000Z",
    },
  );
  const data = decodeSession(html) as {
    beaconFeedback?: { status: string; items?: unknown[] };
  };
  assert.equal(data.beaconFeedback?.status, "items");
  assert.equal(data.beaconFeedback?.items?.length, 2);
  assert.match(html, /data-priority="high"/);
  assert.match(html, /data-category="dependency"/);
  assert.match(html, /GRAFANA_READER_TOKEN_PROD is unset\./);
  assert.match(html, /data-priority="medium"/);
  assert.match(html, /task.md never says to call no_reply/);
});

test("escapes summary text in the Feedback markup", () => {
  const markup = renderFeedbackMarkup({
    status: "items",
    items: [
      {
        priority: "high",
        category: "tool",
        summary: `<img src=x onerror="alert(1)">`,
      },
    ],
  });
  assert.match(markup, /&lt;img src=x/);
  assert.doesNotMatch(markup, /<img src=x/);
});

test("leaves HTML unchanged when the session-data script is missing and the field is hidden", () => {
  const original = "<html>exported</html>";
  assert.equal(fillExportedHtmlFeedback(original, undefined), original);
});
