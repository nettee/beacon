import assert from "node:assert/strict";
import test from "node:test";

import {
  createRunQueue,
  profileLimitsFromProfiles,
  RunQueue,
} from "./queue.js";

test("enforces concurrency and FIFO queue order within a profile", async () => {
  const queue = new RunQueue({ maxConcurrent: 1, maxQueued: 2 });
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue("alpha", async () => {
    events.push("first:start");
    await blocked;
    events.push("first:end");
  });
  const second = queue.enqueue("alpha", async () => {
    events.push("second");
  });
  const third = queue.enqueue("alpha", async () => {
    events.push("third");
  });
  assert.equal(queue.enqueue("alpha", async () => undefined).accepted, false);
  assert.deepEqual(events, ["first:start"]);
  release();
  if (!first.accepted || !second.accepted || !third.accepted)
    assert.fail("queue rejected work");
  await Promise.all([first.completion, second.completion, third.completion]);
  assert.deepEqual(events, ["first:start", "first:end", "second", "third"]);
});

test("waits for capacity in FIFO order without allowing immediate work to overtake", async () => {
  const queue = new RunQueue({ maxConcurrent: 1, maxQueued: 0 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue("alpha", () => blocked);
  const order: number[] = [];
  const second = queue.enqueueWhenAvailable("alpha", async () => {
    order.push(2);
  });
  const third = queue.enqueueWhenAvailable("alpha", async () => {
    order.push(3);
  });
  assert.equal(
    queue.enqueue("alpha", async () => {
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
  const queue = new RunQueue({ maxConcurrent: 1, maxQueued: 0 });
  const failed = queue.enqueueWhenAvailable("alpha", async () => {
    throw new Error("required failure");
  });
  const rejected = assert.rejects(failed, /required failure/);
  let ran = false;
  await queue.enqueueWhenAvailable("alpha", async () => {
    ran = true;
  });
  await rejected;
  assert.equal(ran, true);
});

test("profiles do not share queue slots", async () => {
  const queue = new RunQueue({
    maxConcurrent: 2,
    maxQueued: 0,
    defaultMaxConcurrent: 1,
  });
  let releaseAlpha!: () => void;
  let releaseBeta!: () => void;
  const alphaBlocked = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  const betaBlocked = new Promise<void>((resolve) => {
    releaseBeta = resolve;
  });
  const alpha = queue.enqueue("alpha", () => alphaBlocked);
  const beta = queue.enqueue("beta", () => betaBlocked);
  assert.ok(alpha.accepted);
  assert.ok(beta.accepted);
  // Each profile's own queue is full (max_queued=0 while active), but the other
  // profile is unaffected.
  assert.equal(queue.enqueue("alpha", async () => undefined).accepted, false);
  assert.equal(queue.enqueue("beta", async () => undefined).accepted, false);
  releaseAlpha();
  releaseBeta();
  await Promise.all([alpha.completion, beta.completion]);
});

test("per-profile concurrency is independent under the global ceiling", async () => {
  const queue = new RunQueue({
    maxConcurrent: 3,
    maxQueued: 10,
    defaultMaxConcurrent: 1,
    profiles: { diagnoser: { maxConcurrent: 2 } },
  });
  const releases: Array<() => void> = [];
  const block = (): Promise<void> =>
    new Promise<void>((resolve) => {
      releases.push(resolve);
    });
  const started: string[] = [];
  const d1 = queue.enqueue("diagnoser", async () => {
    started.push("d1");
    await block();
  });
  const d2 = queue.enqueue("diagnoser", async () => {
    started.push("d2");
    await block();
  });
  const other = queue.enqueue("other", async () => {
    started.push("other");
    await block();
  });
  assert.ok(d1.accepted && d2.accepted && other.accepted);
  // Let microtasks start the three concurrent tasks.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started.sort(), ["d1", "d2", "other"]);
  // Diagnoser is at its per-profile max (2); fourth diagnoser must queue.
  let fourthStarted = false;
  const d4 = queue.enqueue("diagnoser", async () => {
    fourthStarted = true;
  });
  assert.ok(d4.accepted);
  await Promise.resolve();
  assert.equal(fourthStarted, false);
  // Global ceiling is full (3); another profile also waits even with free
  // per-profile capacity.
  let fifthStarted = false;
  const extra = queue.enqueue("extra", async () => {
    fifthStarted = true;
  });
  assert.ok(extra.accepted);
  await Promise.resolve();
  assert.equal(fifthStarted, false);
  for (const release of releases.splice(0)) release();
  await Promise.all([
    d1.completion,
    d2.completion,
    other.completion,
    d4.completion,
    extra.completion,
  ]);
  assert.equal(fourthStarted, true);
  assert.equal(fifthStarted, true);
});

test("saturated profile pending does not block another profile with free slots", async () => {
  const queue = new RunQueue({
    maxConcurrent: 2,
    maxQueued: 5,
    defaultMaxConcurrent: 1,
    profiles: { busy: { maxConcurrent: 1 } },
  });
  let releaseBusy!: () => void;
  const busyBlocked = new Promise<void>((resolve) => {
    releaseBusy = resolve;
  });
  const order: string[] = [];
  const busy = queue.enqueue("busy", async () => {
    order.push("busy:start");
    await busyBlocked;
    order.push("busy:end");
  });
  // Second busy task sits at the head of the global pending FIFO but cannot
  // start until the first finishes (per-profile cap).
  const busyQueued = queue.enqueue("busy", async () => {
    order.push("busy:queued");
  });
  const free = queue.enqueue("free", async () => {
    order.push("free");
  });
  assert.ok(busy.accepted && busyQueued.accepted && free.accepted);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["busy:start", "free"]);
  releaseBusy();
  await Promise.all([busy.completion, busyQueued.completion, free.completion]);
  assert.deepEqual(order, ["busy:start", "free", "busy:end", "busy:queued"]);
});

test("rejects invalid constructor limits", () => {
  assert.throws(
    () => new RunQueue({ maxConcurrent: 0, maxQueued: 1 }),
    /maxConcurrent/,
  );
  assert.throws(
    () =>
      new RunQueue({
        maxConcurrent: 2,
        maxQueued: 1,
        defaultMaxConcurrent: 3,
      }),
    /defaultMaxConcurrent/,
  );
  assert.throws(
    () =>
      new RunQueue({
        maxConcurrent: 2,
        maxQueued: 1,
        profiles: { hot: { maxConcurrent: 5 } },
      }),
    /hot/,
  );
});

test("builds profile limits from Profile yaml fields under the global ceiling", () => {
  assert.deepEqual(
    profileLimitsFromProfiles(
      [
        { id: "alert-diagnoser", maxConcurrent: 2 },
        { id: "other", maxQueued: 5 },
        { id: "plain" },
      ],
      { maxConcurrent: 3, defaultMaxConcurrent: 1 },
    ),
    {
      "alert-diagnoser": { maxConcurrent: 2 },
      other: { maxConcurrent: 1, maxQueued: 5 },
    },
  );
  assert.throws(
    () =>
      profileLimitsFromProfiles([{ id: "hot", maxConcurrent: 5 }], {
        maxConcurrent: 3,
        defaultMaxConcurrent: 1,
      }),
    /exceeds runs.max_concurrent/,
  );
});

test("createRunQueue wires Profile yaml limits into admission", async () => {
  const queue = createRunQueue(
    { maxConcurrent: 3, maxQueued: 0, defaultMaxConcurrent: 1 },
    [{ id: "alert-diagnoser", maxConcurrent: 2 }, { id: "other" }],
  );
  assert.deepEqual(queue.limitsFor("alert-diagnoser"), {
    maxConcurrent: 2,
    maxQueued: 0,
  });
  assert.deepEqual(queue.limitsFor("other"), {
    maxConcurrent: 1,
    maxQueued: 0,
  });
});
