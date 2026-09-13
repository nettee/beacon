import assert from "node:assert/strict";
import test from "node:test";

import { startOutcomeServer } from "./server.js";
import { submitOutcome } from "./submit.js";

test("a Run Capability submits a Final Outcome through the local socket", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      "the explicit final answer\n",
    );
    assert.equal(submission.take(), "the explicit final answer\n");
  } finally {
    await server.close();
  }
});

test("a Run Capability rejects a second Final Outcome", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      "first",
    );
    await assert.rejects(
      submitOutcome(
        submission.binding.socketPath,
        submission.binding.runToken,
        "second",
      ),
      /already submitted/,
    );
    assert.equal(submission.take(), "first");
  } finally {
    await server.close();
  }
});

test("rejects an Outcome request larger than the configured boundary", async () => {
  const server = await startOutcomeServer({ maxRequestBytes: 128 });
  try {
    const submission = server.openRun();
    await assert.rejects(
      submitOutcome(
        submission.binding.socketPath,
        submission.binding.runToken,
        "x".repeat(256),
      ),
      /too large/,
    );
    assert.throws(() => submission.take(), /without submitting/);
  } finally {
    await server.close();
  }
});
