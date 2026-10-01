import assert from "node:assert/strict";
import test from "node:test";

import {
  contentIndicatesFeishuAtAll,
  hasDirectFeishuMention,
  isFeishuAtAllMention,
  shouldProcessFeishuInbound,
} from "./mentions.js";

test("detects @_all mention keys and 所有人 names", () => {
  assert.equal(isFeishuAtAllMention({ key: "@_all", name: "所有人" }), true);
  assert.equal(isFeishuAtAllMention({ key: "@all", name: "All" }), true);
  assert.equal(
    isFeishuAtAllMention({
      key: "@_user_1",
      id: { user_id: "all" },
      name: "所有人",
    }),
    true,
  );
  assert.equal(
    isFeishuAtAllMention({
      key: "@_user_1",
      id: { open_id: "ou_bot" },
      mentioned_type: "bot",
      name: "Beacon",
    }),
    false,
  );
});

test("contentIndicatesFeishuAtAll covers text and post payloads", () => {
  assert.equal(
    contentIndicatesFeishuAtAll(JSON.stringify({ text: "@_all hello" })),
    true,
  );
  assert.equal(
    contentIndicatesFeishuAtAll(
      JSON.stringify({
        zh_cn: {
          content: [[{ tag: "at", user_id: "@_all", user_name: "所有人" }]],
        },
      }),
    ),
    true,
  );
  assert.equal(
    contentIndicatesFeishuAtAll(JSON.stringify({ text: "@_user_1 hello" })),
    false,
  );
});

test("pure @All group events are ignored; DM and @bot are accepted", () => {
  assert.equal(
    shouldProcessFeishuInbound({
      chatType: "p2p",
      mentions: [{ key: "@_all", name: "所有人" }],
    }),
    true,
  );

  assert.equal(
    shouldProcessFeishuInbound({
      chatType: "group",
      mentions: [{ key: "@_all", name: "所有人" }],
      content: JSON.stringify({ text: "@_all FYI" }),
    }),
    false,
  );

  assert.equal(
    shouldProcessFeishuInbound({
      chatType: "group",
      mentions: [],
      content: JSON.stringify({ text: "@_all only" }),
    }),
    false,
  );

  assert.equal(
    shouldProcessFeishuInbound({
      chatType: "group",
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          mentioned_type: "bot",
          name: "Beacon",
        },
      ],
    }),
    true,
  );

  assert.equal(
    shouldProcessFeishuInbound({
      chatType: "group",
      mentions: [
        { key: "@_all", name: "所有人" },
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          mentioned_type: "bot",
          name: "Beacon",
        },
      ],
    }),
    true,
  );
});

test("explicit user mentions are not treated as bot mentions", () => {
  assert.equal(
    hasDirectFeishuMention([
      {
        key: "@_user_1",
        id: { open_id: "ou_person" },
        mentioned_type: "user",
        name: "Tom",
      },
    ]),
    false,
  );
});

test("omitted mentioned_type with an open_id still counts as a direct mention", () => {
  assert.equal(
    hasDirectFeishuMention([
      {
        key: "@_user_1",
        id: { open_id: "ou_bot" },
        name: "Beacon",
      },
    ]),
    true,
  );
});
