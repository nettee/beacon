import assert from "node:assert/strict";
import test from "node:test";
import { matchesListener, parseCloudEvent } from "./cloudevent.js";

const event = {
  specversion: "1.0",
  id: "evt-1",
  source: "/deploy/production",
  type: "deployment.completed.v1",
};

test("CloudEvents retain JSON data and scalar extensions without normalizing identity", () => {
  const input = {
    ...event,
    data: { version: 1, result: null },
    traceparent: "trace",
    attempts: 2,
    trusted: false,
  };
  assert.deepEqual(parseCloudEvent(input), input);
  assert.deepEqual(parseCloudEvent(event), event);
});

test("invalid CloudEvents are rejected", () => {
  for (const patch of [
    { specversion: "0.3" },
    { id: "" },
    { source: "bad source" },
    { source: "/bad%escape" },
    { source: "http://[bad" },
    { source: "/path[invalid]" },
    { source: "path#one#two" },
    { type: "" },
    { subject: "" },
    { time: "yesterday" },
    { time: "2026-02-30T00:00:00Z" },
    { dataschema: "/relative" },
    { datacontenttype: "text/plain" },
    { data_base64: "YQ==" },
    { Invalid: "extension" },
    { nested: {} },
    { fractional: 1.5 },
    { nullable: null },
  ])
    assert.throws(
      () => parseCloudEvent({ ...event, ...patch }),
      JSON.stringify(patch),
    );
  assert.throws(() => parseCloudEvent([event]));
});

test("accepts absolute and relative sources, URI schemas, timestamps and JSON media types", () => {
  for (const source of [
    "urn:example:deployment",
    "https://deploy.example.com/events",
    "relative/path",
    "../event",
    "#fragment",
  ]) {
    assert.equal(parseCloudEvent({ ...event, source }).source, source);
  }
  parseCloudEvent({
    ...event,
    dataschema: "urn:example:schema",
    time: "2026-09-29T12:00:00+08:00",
    datacontenttype: "application/vnd.example+json",
    data: null,
  });
});

test("listener matches OR within each list and AND between lists exactly", () => {
  const parsed = parseCloudEvent(event);
  assert.equal(
    matchesListener(parsed, {
      sources: ["other", event.source],
      types: [event.type, "other"],
    }),
    true,
  );
  assert.equal(
    matchesListener(parsed, { sources: [event.source], types: ["other"] }),
    false,
  );
  assert.equal(
    matchesListener(parsed, { sources: ["other"], types: [event.type] }),
    false,
  );
  assert.equal(
    matchesListener(parsed, { sources: ["*"], types: [event.type] }),
    false,
  );
});
