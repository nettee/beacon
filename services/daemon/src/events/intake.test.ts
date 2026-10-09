import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EventProducer } from "../config/event-credentials.js";
import type { Profile } from "../config/profile.js";
import { TriggerStore } from "../state/trigger-store.js";
import type { CloudEvent } from "./cloudevent.js";
import { type EventContext, EventPipeline } from "./pipeline.js";
import { startEventServer } from "./server.js";
import { EventStore, eventStatus } from "./store.js";

const event: CloudEvent = {
  specversion: "1.0",
  source: "https://example.com/deploy",
  type: "com.example.deployed.v1",
  id: "one",
  data: { service: "payments" },
};
const producer: EventProducer = {
  id: "deploy",
  token: "abcdefghijklmnopqrstuvwxyz123456",
  sources: [event.source],
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(onProcess?: (context: EventContext) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "beacon-events-"));
  const store = new EventStore(join(directory, "events"));
  const executions: string[] = [];
  const errors: Error[] = [];
  const contexts = ["a", "b", "unsubscribed", "other"].map((id) => {
    const profile: Profile = {
      id,
      directory: join(directory, id),
      playbook: directory,
      persona: "persona",
      task: "task",
      runtime: "pi",
      model: { provider: "test", id: "test" },
      schedules: [],
      admin: { chatId: `admin-${id}` },
      ...(id === "unsubscribed"
        ? {}
        : {
            listener: {
              sources: [event.source],
              types: [id === "other" ? "other.type" : event.type],
              notify: { chatId: `group-${id}` },
            },
          }),
    };
    const context: EventContext = {
      profile,
      store: new TriggerStore(profile.directory, id),
      orchestrator: {
        async process(_key, normalize) {
          assert.deepEqual(await normalize(), { kind: "event", event });
          executions.push(id);
          await onProcess?.(context);
        },
      },
    };
    return context;
  });
  const pipeline = new EventPipeline({
    store,
    contexts,
    maxPending: 2,
    onFatal: (error) => errors.push(error),
  });
  return { directory, store, contexts, pipeline, executions, errors };
}

test("HTTP acknowledges durable acceptance before execution and deduplicates concurrent retries", async (t) => {
  const gate = deferred();
  const fixtureData = await fixture(async () => gate.promise);
  const { store, pipeline, contexts, executions, errors } = fixtureData;
  const server = await startEventServer({
    listen: "127.0.0.1",
    port: 0,
    maxBodyBytes: 4096,
    producers: [producer],
    pipeline,
    store,
    onFatal: (e) => errors.push(e),
  });
  t.after(async () => {
    gate.resolve();
    await server.close();
    await pipeline.close();
  });
  const url = `http://127.0.0.1:${server.port}/v1/events`;
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${producer.token}`,
        "content-type": "application/cloudevents+json",
      },
      body: JSON.stringify(event),
    });
  const first = await send();
  assert.equal(first.status, 202);
  const accepted = (await first.json()) as {
    receipt_id: string;
    status: string;
  };
  assert.equal(accepted.status, "pending");
  assert.equal((await store.get(accepted.receipt_id))?.recipients.length, 2);
  const retries = await Promise.all(Array.from({ length: 8 }, send));
  assert.deepEqual(
    retries.map((r) => r.status),
    Array(8).fill(200),
  );
  const status = await fetch(`${url}/${accepted.receipt_id}`, {
    headers: { authorization: `Bearer ${producer.token}` },
  });
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { status: string }).status, "pending");
  gate.resolve();
  await pipeline.drain();
  assert.deepEqual(executions, ["a", "b"]);
  for (const context of contexts.slice(0, 2)) {
    const records = await context.store.list();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.input, { kind: "event", event });
    assert.deepEqual(records[0]?.target, {
      kind: "chat",
      chatId: `admin-${context.profile.id}`,
    });
    assert.deepEqual(records[0]?.notifyTarget, {
      kind: "chat",
      chatId: `group-${context.profile.id}`,
    });
  }
  assert.equal(
    eventStatus((await store.get(accepted.receipt_id))!),
    "dispatched",
  );
  assert.deepEqual(errors, []);
  const files = await readdir(store.directory);
  const persisted = await readFile(
    join(store.directory, files.find((f) => f.endsWith(".json"))!),
    "utf8",
  );
  assert.ok(!persisted.includes(producer.token));
});

test("unmatched receipts stay unmatched after listener changes and replay", async () => {
  const { store, pipeline, contexts, executions } = await fixture();
  for (const context of contexts) delete context.profile.listener;
  const accepted = await pipeline.accept(event, producer);
  await pipeline.drain();
  assert.equal(eventStatus(accepted.record), "unmatched");
  contexts[0]!.profile.listener = {
    sources: [event.source],
    types: [event.type],
  };
  const duplicate = await pipeline.accept(event, producer);
  await pipeline.drain();
  assert.equal(duplicate.created, false);
  assert.equal(eventStatus(duplicate.record), "unmatched");
  assert.deepEqual(executions, []);
  assert.equal(await store.get(`evt_${"0".repeat(64)}`), undefined);
});

test("restart resumes saved recipients and destinations without rematching listeners", async () => {
  const { directory, contexts, executions, errors } = await fixture();
  const oldStore = new EventStore(join(directory, "events"));
  const accepted = await oldStore.accept(
    event,
    producer.id,
    [{ profileId: "a", chatId: "saved-admin", notifyChatId: "saved-group" }],
    10,
  );
  delete contexts[0]!.profile.listener;
  contexts[0]!.profile.admin = { chatId: "changed-admin" };
  const store = new EventStore(join(directory, "events"));
  const pipeline = new EventPipeline({
    store,
    contexts,
    maxPending: 10,
    onFatal: (e) => errors.push(e),
  });
  pipeline.wake();
  await pipeline.drain();
  assert.deepEqual(executions, ["a"]);
  const record = (await contexts[0]!.store.list())[0]!;
  assert.deepEqual(record.target, { kind: "chat", chatId: "saved-admin" });
  assert.deepEqual(record.notifyTarget, {
    kind: "chat",
    chatId: "saved-group",
  });
  assert.equal(
    eventStatus((await store.get(accepted.record.receiptId))!),
    "dispatched",
  );
  assert.deepEqual(errors, []);
});

test("a crash between Trigger processing and receipt update does not execute twice", async () => {
  const { store, pipeline, contexts, executions, errors } = await fixture();
  const original = store.markDispatched.bind(store);
  store.markDispatched = async () => {
    throw new Error("simulated receipt disk failure");
  };
  const accepted = await pipeline.accept(event, producer);
  await assert.rejects(pipeline.drain(), /Event dispatch failed/);
  assert.equal(errors.length, 1);
  assert.deepEqual(executions, ["a"]);
  store.markDispatched = original;
  // Runtime recovery handles any nonterminal existing Trigger before dispatcher startup.
  const restarted = new EventPipeline({
    store,
    contexts,
    maxPending: 2,
    onFatal: (e) => errors.push(e),
  });
  restarted.wake();
  await restarted.drain();
  assert.deepEqual(executions, ["a", "b"]);
  assert.equal(
    eventStatus((await store.get(accepted.record.receiptId))!),
    "dispatched",
  );
});

test("bounded inbox rejects new work without poisoning identity and still accepts duplicates", async () => {
  const { store } = await fixture();
  const recipients = [{ profileId: "a", chatId: "admin" }];
  const first = await store.accept(event, producer.id, recipients, 1);
  const next = { ...event, id: "two" };
  await assert.rejects(store.accept(next, producer.id, recipients, 1), {
    status: 503,
  });
  assert.equal(
    (await store.accept(event, producer.id, recipients, 1)).created,
    false,
  );
  await store.markDispatched(first.record.receiptId, "a", "trigger-one");
  assert.equal(
    (await store.accept(next, producer.id, recipients, 1)).created,
    true,
  );
  await assert.rejects(
    store.accept(
      { ...event, data: { changed: true } },
      producer.id,
      recipients,
      1,
    ),
    { status: 409 },
  );
});

test("missing pending Profile and corrupt inbox fail visibly", async () => {
  const { store, contexts, errors } = await fixture();
  const accepted = await store.accept(
    event,
    producer.id,
    [{ profileId: "removed", chatId: "admin" }],
    2,
  );
  const pipeline = new EventPipeline({
    store,
    contexts,
    maxPending: 2,
    onFatal: (e) => errors.push(e),
  });
  pipeline.wake();
  await assert.rejects(pipeline.drain(), /Event dispatch failed/);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]!.cause), /missing Profile removed/);
  await assert.rejects(pipeline.accept({ ...event, id: "two" }, producer), {
    status: 503,
  });
  await writeFile(
    join(store.directory, `${accepted.record.receiptId}.json`),
    "broken",
  );
  await assert.rejects(store.pending());
});

test("HTTP enforces auth, source scope, modes, limits, identity conflicts and receipt isolation", async (t) => {
  const { store, pipeline, errors } = await fixture();
  const other: EventProducer = {
    id: "other",
    token: "123456abcdefghijklmnopqrstuvwxyz",
    sources: [event.source],
  };
  const server = await startEventServer({
    listen: "127.0.0.1",
    port: 0,
    maxBodyBytes: 512,
    producers: [producer, other],
    pipeline,
    store,
    onFatal: (e) => errors.push(e),
  });
  t.after(async () => {
    await server.close();
    await pipeline.close();
  });
  const url = `http://127.0.0.1:${server.port}/v1/events`;
  const send = (value: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${producer.token}`,
        "content-type": "application/cloudevents+json",
        ...headers,
      },
      body: JSON.stringify(value),
    });
  assert.equal(
    (await send(event, { authorization: "Bearer wrong" })).status,
    401,
  );
  assert.equal(
    (await send({ ...event, source: "https://untrusted.example" })).status,
    403,
  );
  assert.equal(
    (await send(event, { "content-type": "application/json" })).status,
    415,
  );
  assert.equal((await send(event, { "content-encoding": "gzip" })).status, 415);
  assert.equal((await send([event])).status, 400);
  assert.equal((await send({ ...event, specversion: "2.0" })).status, 400);
  assert.equal((await send({ ...event, data_base64: "YQ==" })).status, 400);
  assert.equal((await send({ ...event, data: "x".repeat(1024) })).status, 413);
  const chunkedStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${producer.token}`,
          "content-type": "application/cloudevents+json",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.write("x".repeat(300));
    request.end("x".repeat(300));
  });
  assert.equal(chunkedStatus, 413);
  const accepted = await send(event);
  assert.equal(accepted.status, 202);
  const record = (await accepted.json()) as { receipt_id: string };
  assert.equal(
    (await send({ ...event, data: { different: true } })).status,
    409,
  );
  assert.equal(
    (await send(event, { authorization: `Bearer ${other.token}` })).status,
    409,
  );
  const hidden = await fetch(`${url}/${record.receipt_id}`, {
    headers: { authorization: `Bearer ${other.token}` },
  });
  assert.equal(hidden.status, 404);
  assert.deepEqual(errors, []);
});

test("HTTP persistence failures return 500 and report fatal instead of acknowledging", async (t) => {
  const { store, pipeline, errors } = await fixture();
  store.accept = async () => {
    throw new Error("disk full");
  };
  const server = await startEventServer({
    listen: "127.0.0.1",
    port: 0,
    maxBodyBytes: 4096,
    producers: [producer],
    pipeline,
    store,
    onFatal: (e) => errors.push(e),
  });
  t.after(async () => {
    await server.close();
    await pipeline.close();
  });
  const send = () =>
    fetch(`http://127.0.0.1:${server.port}/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${producer.token}`,
        "content-type": "application/cloudevents+json",
      },
      body: JSON.stringify(event),
    });
  assert.equal((await send()).status, 500);
  assert.equal(errors.length, 1);
  assert.equal((await send()).status, 503);
});

test("shutdown reports a required dispatch failure even after stopping intake", async () => {
  const started = deferred();
  const gate = deferred();
  const { pipeline, errors } = await fixture(async () => {
    started.resolve();
    await gate.promise;
    throw new Error("required write failed during shutdown");
  });
  await pipeline.accept(event, producer);
  await started.promise;
  const closed = pipeline.close();
  gate.resolve();
  await assert.rejects(closed, /Event dispatch failed/);
  assert.equal(errors.length, 1);
});
