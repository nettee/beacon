import assert from "node:assert/strict";
import test from "node:test";

import { startOutcomeServer } from "./server.js";
import { submitOutcome } from "./submit.js";

test("a Run Capability submits a reply through the local socket", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      { reply: { kind: "text", text: "the explicit final answer\n" } },
    );
    assert.deepEqual(submission.take(), {
      reply: { kind: "text", text: "the explicit final answer\n" },
    });
  } finally {
    await server.close();
  }
});

test("a Run Capability rejects a second reply", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      { reply: { kind: "text", text: "first" } },
    );
    await assert.rejects(
      submitOutcome(
        submission.binding.socketPath,
        submission.binding.runToken,
        { reply: { kind: "text", text: "second" } },
      ),
      /already submitted/,
    );
    assert.deepEqual(submission.take(), {
      reply: { kind: "text", text: "first" },
    });
  } finally {
    await server.close();
  }
});

test("a Run Capability merges notify_card with no_reply", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    const card = {
      kind: "card" as const,
      title: "Report",
      content: "- completed",
      buttons: [{ label: "Open", url: "https://example.com" }],
    };
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      { notify: card },
    );
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      { reply: { kind: "no_reply", reason: "announced" } },
    );
    assert.deepEqual(submission.take(), {
      reply: { kind: "no_reply", reason: "announced" },
      notify: card,
    });
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
        { reply: { kind: "text", text: "x".repeat(256) } },
      ),
      /too large/,
    );
    assert.throws(() => submission.take(), /without submitting/);
  } finally {
    await server.close();
  }
});

test("a Run Capability submits feedback without blocking reply", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      {
        feedback: {
          items: [
            {
              priority: "high",
              summary: "GRAFANA_READER_TOKEN_PROD is unset.",
            },
          ],
        },
      },
    );
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      { reply: { kind: "text", text: "done" } },
    );
    const feedback = submission.takeFeedback();
    assert.deepEqual(feedback?.items, [
      {
        priority: "high",
        summary: "GRAFANA_READER_TOKEN_PROD is unset.",
      },
    ]);
    assert.equal(typeof feedback?.submittedAt, "string");
    assert.deepEqual(submission.take(), {
      reply: { kind: "text", text: "done" },
    });
  } finally {
    await server.close();
  }
});

test("a Run Capability rejects a second feedback submission", async () => {
  const server = await startOutcomeServer();
  try {
    const submission = server.openRun();
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      {
        feedback: {
          items: [
            {
              priority: "high",
              summary: "GRAFANA_READER_TOKEN_PROD is unset.",
            },
          ],
        },
      },
    );
    await assert.rejects(
      submitOutcome(
        submission.binding.socketPath,
        submission.binding.runToken,
        {
          feedback: {
            items: [
              {
                priority: "medium",
                summary: "task.md never says to call no_reply on empty hours.",
              },
            ],
          },
        },
      ),
      /already submitted/,
    );
    await submitOutcome(
      submission.binding.socketPath,
      submission.binding.runToken,
      { reply: { kind: "no_reply", reason: "announced" } },
    );
    assert.equal(submission.takeFeedback()?.items.length, 1);
    assert.deepEqual(submission.take(), {
      reply: { kind: "no_reply", reason: "announced" },
    });
  } finally {
    await server.close();
  }
});
