import assert from "node:assert/strict";
import test from "node:test";

import { shouldExerciseReplyExperiment } from "./reply-experiment.js";

test("the first direct message triggers regardless of its text", () => {
  assert.equal(shouldExerciseReplyExperiment("p2p", "dm-1", new Set()), true);
});

test("the first group mention triggers regardless of its text", () => {
  assert.equal(shouldExerciseReplyExperiment("group", "group-1", new Set()), true);
});

test("a second distinct message of the same chat type also triggers", () => {
  assert.equal(shouldExerciseReplyExperiment("group", "group-2", new Set(["group-1"])), true);
});

test("a duplicate delivery of the same message does not trigger again", () => {
  assert.equal(shouldExerciseReplyExperiment("group", "group-1", new Set(["group-1"])), false);
});

test("unknown chat types do not trigger", () => {
  assert.equal(shouldExerciseReplyExperiment("unknown", "message-1", new Set()), false);
});
