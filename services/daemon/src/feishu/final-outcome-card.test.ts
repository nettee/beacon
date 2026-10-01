import assert from "node:assert/strict";
import test from "node:test";

import { buildFeishuFinalOutcomeCard } from "./final-outcome-card.js";

const generatedAt = new Date("2026-09-15T02:38:12.000Z");

test("renders an explicit card outcome with Markdown, buttons, and timestamp", () => {
  const card = buildFeishuFinalOutcomeCard(
    {
      kind: "card",
      title: "AMR 生产发布影响报告",
      content: [
        "- XXL | CMS 活动生命周期、实时 Test 与生产 Campaign",
        "- XL | Astra 272K+ 长上下文费率",
      ].join("\n"),
      buttons: [
        { label: "查看 HTML 报告", url: "https://example.com/report" },
        {
          label: "查看 GitHub Compare",
          url: "https://github.com/example/compare",
        },
      ],
    },
    { generatedAt, timeZone: "Asia/Shanghai" },
  );

  assert.equal(card.header.title.content, "AMR 生产发布影响报告");
  assert.deepEqual(card.elements, [
    {
      tag: "markdown",
      content:
        "- XXL | CMS 活动生命周期、实时 Test 与生产 Campaign\n- XL | Astra 272K+ 长上下文费率",
    },
    { tag: "hr" },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "查看 HTML 报告" },
          url: "https://example.com/report",
          type: "primary",
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "查看 GitHub Compare" },
          url: "https://github.com/example/compare",
          type: "default",
        },
      ],
    },
    {
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: "卡片生成时间：2026-09-15 10:38:12",
        },
      ],
    },
  ]);
});

test("omits the action row when the card has no buttons", () => {
  const card = buildFeishuFinalOutcomeCard(
    {
      kind: "card",
      title: "Beacon 任务结果",
      content: "A card without actions",
      buttons: [],
    },
    { generatedAt, timeZone: "UTC" },
  );

  assert.deepEqual(card.elements, [
    { tag: "markdown", content: "A card without actions" },
    {
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: "卡片生成时间：2026-09-15 02:38:12",
        },
      ],
    },
  ]);
});
