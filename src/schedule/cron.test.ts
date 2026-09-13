import assert from "node:assert/strict";
import test from "node:test";

import { occurrencesBetween } from "./cron.js";

test("calculates a five-field occurrence in an IANA timezone", () => {
  assert.deepEqual(
    occurrencesBetween(
      "0 9 * * *",
      "Asia/Shanghai",
      new Date("2026-09-12T00:59:00.000Z"),
      new Date("2026-09-12T01:00:00.000Z"),
      10,
    ).map((date) => date.toISOString()),
    ["2026-09-12T01:00:00.000Z"],
  );
});

test("rejects six-field cron instead of changing the first field meaning", () => {
  assert.throws(
    () => occurrencesBetween("0 0 9 * * *", "Asia/Shanghai", new Date(), new Date(), 10),
    /five fields/,
  );
});

test("fails rather than truncating occurrence enumeration", () => {
  assert.throws(
    () =>
      occurrencesBetween(
        "* * * * *",
        "UTC",
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T00:03:00Z"),
        2,
      ),
    /exceeds limit/,
  );
});

test("uses cron-parser's deterministic DST gap behavior", () => {
  assert.deepEqual(
    occurrencesBetween(
      "30 2 * * *",
      "America/New_York",
      new Date("2026-03-08T06:00:00.000Z"),
      new Date("2026-03-08T08:00:00.000Z"),
      10,
    ).map((date) => date.toISOString()),
    ["2026-03-08T07:30:00.000Z"],
  );
});

test("emits one occurrence during a repeated DST fold hour", () => {
  assert.deepEqual(
    occurrencesBetween(
      "30 1 * * *",
      "America/New_York",
      new Date("2026-11-01T04:00:00.000Z"),
      new Date("2026-11-01T07:00:00.000Z"),
      10,
    ).map((date) => date.toISOString()),
    ["2026-11-01T05:30:00.000Z"],
  );
});
