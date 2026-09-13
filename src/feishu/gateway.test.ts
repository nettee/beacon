import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { shouldAcceptFeishuMessage, waitForShutdown } from "./gateway.js";

test("accepts distinct user messages from direct and group chats", () => {
  assert.equal(
    shouldAcceptFeishuMessage("p2p", "user", "dm-1", new Set()),
    true,
  );
  assert.equal(
    shouldAcceptFeishuMessage("group", "user", "group-1", new Set()),
    true,
  );
  assert.equal(
    shouldAcceptFeishuMessage("group", "user", "group-2", new Set(["group-1"])),
    true,
  );
});

test("rejects duplicates, application senders, and unsupported chats", () => {
  assert.equal(
    shouldAcceptFeishuMessage(
      "group",
      "user",
      "message-1",
      new Set(["message-1"]),
    ),
    false,
  );
  assert.equal(
    shouldAcceptFeishuMessage("group", "app", "message-1", new Set()),
    false,
  );
  assert.equal(
    shouldAcceptFeishuMessage("unknown", "user", "message-1", new Set()),
    false,
  );
});

test("keeps the Gateway alive until the process receives a shutdown signal", async () => {
  const signals = new EventEmitter();
  let settled = false;
  const lifetime = waitForShutdown(signals).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  signals.emit("SIGTERM");
  await lifetime;
  assert.equal(settled, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
