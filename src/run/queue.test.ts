import assert from "node:assert/strict";
import test from "node:test";

import { RunQueue } from "./queue.js";

test("enforces concurrency and FIFO queue order", async () => {
  const queue = new RunQueue(1, 2);
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(async () => {
    events.push("first:start");
    await blocked;
    events.push("first:end");
  });
  const second = queue.enqueue(async () => {
    events.push("second");
  });
  const third = queue.enqueue(async () => {
    events.push("third");
  });
  assert.equal(queue.enqueue(async () => undefined).accepted, false);
  assert.deepEqual(events, ["first:start"]);
  release();
  if (!first.accepted || !second.accepted || !third.accepted)
    assert.fail("queue rejected work");
  await Promise.all([first.completion, second.completion, third.completion]);
  assert.deepEqual(events, ["first:start", "first:end", "second", "third"]);
});
