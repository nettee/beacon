import assert from "node:assert/strict";
import test from "node:test";

import { runMessageE2e } from "./run.js";

test("a synthetic Feishu message reaches a real Pi Run and is replied to once", async () => {
  const result = await runMessageE2e("BEACON_E2E_MESSAGE_PROBE");

  assert.equal(result.intake, "accepted");
  assert.deepEqual(result.acknowledgedMessageIds, [result.messageId]);
  assert.equal(result.record.input?.kind, "feishu_message");
  assert.equal(result.record.run?.state, "succeeded");
  assert.equal(result.record.finalOutcome?.origin, "agent");
  assert.equal(
    result.record.finalOutcome?.text,
    "BEACON_E2E_MESSAGE_PROBE\nBEACON_E2E_MESSAGE_PROBE\nBEACON_E2E_MESSAGE_PROBE",
  );
  assert.equal(result.record.delivery?.state, "delivered");
  assert.deepEqual(result.deliveries, [
    {
      target: { kind: "reply", messageId: result.messageId },
      text: "BEACON_E2E_MESSAGE_PROBE\nBEACON_E2E_MESSAGE_PROBE\nBEACON_E2E_MESSAGE_PROBE",
    },
  ]);
});
