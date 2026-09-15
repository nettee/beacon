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
      { kind: "text", text: "the explicit final answer\n" },
    );
    assert.deepEqual(submission.take(), {
      kind: "text",
      text: "the explicit final answer\n",
    });
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
      { kind: "text", text: "first" },
    );
    await assert.rejects(
      submitOutcome(
        submission.binding.socketPath,
        submission.binding.runToken,
        { kind: "text", text: "second" },
      ),
      /already submitted/,
    );
    assert.deepEqual(submission.take(), { kind: "text", text: "first" });
  } finally {
    await server.close();
  }
});

test("a Run Capability accepts a structured card Final Outcome", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    const outcome = {
      kind: "card" as const,
      title: "Report",
      content: "- completed",
      buttons: [{ label: "Open", url: "https://example.com" }],
    };
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      outcome,
    );
    assert.deepEqual(submission.take(), outcome);
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
        { kind: "text", text: "x".repeat(256) },
      ),
      /too large/,
    );
    assert.throws(() => submission.take(), /without submitting/);
  } finally {
    await server.close();
  }
});
