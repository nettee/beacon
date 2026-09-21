import assert from "node:assert/strict";
import test from "node:test";

import {
  fillExportedHtmlSystemPrompt,
  systemPromptFromJsonl,
} from "./session-prompt.js";

function sessionHtml(data: unknown): string {
  const encoded = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  return `<!doctype html><script id="session-data" type="application/json">${encoded}</script>`;
}

function decodeSession(html: string): unknown {
  const match = /id="session-data"[^>]*>([^<]*)<\/script>/.exec(html);
  assert.ok(match?.[1]);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

test("replays JSONL system messages into one prompt string", () => {
  const jsonl = [
    '{"type":"session","id":"run_ok"}',
    '{"type":"message","message":{"role":"system","content":"base","sections":{"a":"<a>1</a>","b":"<b>1</b>"}}}',
    '{"type":"message","message":{"role":"user","content":"hello"}}',
    '{"type":"message","message":{"role":"system","content":"also do this"}}',
    '{"type":"message","message":{"role":"system","content":"","sections":{"a":"<a>2</a>","b":null,"c":"<c>1</c>"}}}',
  ].join("\n");
  assert.equal(
    systemPromptFromJsonl(jsonl),
    "base\n\nalso do this\n\n<a>2</a>\n\n<c>1</c>",
  );
});

test("reads structured sections when content is empty", () => {
  const jsonl = [
    '{"type":"message","message":{"role":"system","content":"","sections":{"preamble":"You are Beacon.","cwd":"Current working directory: /workspace"}}}',
  ].join("\n");
  assert.equal(
    systemPromptFromJsonl(jsonl),
    "You are Beacon.\n\nCurrent working directory: /workspace",
  );
});

test("joins text content blocks from a system message", () => {
  const jsonl =
    '{"type":"message","message":{"role":"system","content":[{"type":"text","text":"first"},{"type":"text","text":"second"}]}}\n';
  assert.equal(systemPromptFromJsonl(jsonl), "first\nsecond");
});

test("returns undefined when the session has no system message", () => {
  const jsonl = [
    '{"type":"session"}',
    '{"type":"message","message":{"role":"user","content":"hi"}}',
  ].join("\n");
  assert.equal(systemPromptFromJsonl(`${jsonl}\n`), undefined);
});

test("fills an empty Pi session-data systemPrompt slot", () => {
  const html = fillExportedHtmlSystemPrompt(
    sessionHtml({ header: { id: "run_ok" }, systemPrompt: undefined }),
    "You are Beacon.",
  );
  assert.deepEqual(decodeSession(html), {
    header: { id: "run_ok" },
    systemPrompt: "You are Beacon.",
  });
});

test("leaves HTML unchanged when Pi already filled systemPrompt", () => {
  const original = sessionHtml({ systemPrompt: "from live export" });
  assert.equal(fillExportedHtmlSystemPrompt(original, "from jsonl"), original);
});

test("leaves HTML unchanged when the session-data script is missing", () => {
  const original = "<html>exported</html>";
  assert.equal(
    fillExportedHtmlSystemPrompt(original, "You are Beacon."),
    original,
  );
});
