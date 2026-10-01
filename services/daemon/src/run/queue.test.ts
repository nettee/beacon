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

test("waits for capacity in FIFO order without allowing immediate work to overtake", async () => {
  const queue = new RunQueue(1, 0);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(() => blocked);
  const order: number[] = [];
  const second = queue.enqueueWhenAvailable(async () => {
    order.push(2);
  });
  const third = queue.enqueueWhenAvailable(async () => {
    order.push(3);
  });
  assert.equal(
    queue.enqueue(async () => {
      order.push(4);
    }).accepted,
    false,
  );
  assert.deepEqual(order, []);
  release();
  assert.ok(first.accepted);
  await Promise.all([first.completion, second, third]);
  assert.deepEqual(order, [2, 3]);
});

test("waiting task failures propagate and release capacity for the next task", async () => {
  const queue = new RunQueue(1, 0);
  const failed = queue.enqueueWhenAvailable(async () => {
    throw new Error("required failure");
  });
  const rejected = assert.rejects(failed, /required failure/);
  let ran = false;
  await queue.enqueueWhenAvailable(async () => {
    ran = true;
  });
  await rejected;
  assert.equal(ran, true);
});
