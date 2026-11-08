import assert from "node:assert/strict";
import test from "node:test";

import {
  formatFallbackChainExhaustedSummary,
  formatModelChoiceRef,
  isRetryableProviderFailure,
  MAX_MODEL_FALLBACK_CHAIN,
  modelFallbackAttemptIndex,
  modelFallbackSessionId,
  nextModelFallbackChoice,
  sameModelChoice,
} from "./model-fallback.js";

const luna = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  thinking: "high" as const,
};
const grok = {
  provider: "xai",
  id: "grok-4.7",
  thinking: "high" as const,
};
const flash = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
};

test("MAX_MODEL_FALLBACK_CHAIN is 3", () => {
  assert.equal(MAX_MODEL_FALLBACK_CHAIN, 3);
});

test("sameModelChoice compares provider+id+thinking", () => {
  assert.equal(sameModelChoice(luna, luna), true);
  assert.equal(sameModelChoice(luna, { ...luna, thinking: undefined }), false);
  assert.equal(sameModelChoice(flash, { ...flash }), true);
  assert.equal(sameModelChoice(luna, grok), false);
});

test("nextModelFallbackChoice: length 0/1 → no fallback", () => {
  assert.equal(nextModelFallbackChoice(undefined, 0), undefined);
  assert.equal(nextModelFallbackChoice([], 0), undefined);
  assert.equal(nextModelFallbackChoice([luna], 0), undefined);
});

test("nextModelFallbackChoice: 2-model A→B", () => {
  const next = nextModelFallbackChoice([luna, grok], 0);
  assert.deepEqual(next, { choice: grok, nextAttemptIndex: 1 });
  assert.equal(nextModelFallbackChoice([luna, grok], 1), undefined);
});

test("nextModelFallbackChoice: 3-model A→B→C", () => {
  const chain = [luna, grok, flash];
  assert.deepEqual(nextModelFallbackChoice(chain, 0), {
    choice: grok,
    nextAttemptIndex: 1,
  });
  assert.deepEqual(nextModelFallbackChoice(chain, 1), {
    choice: flash,
    nextAttemptIndex: 2,
  });
  assert.equal(nextModelFallbackChoice(chain, 2), undefined);
});

test("isRetryableProviderFailure accepts supplier/API outages", () => {
  const cases = [
    "Pi ended with stopReason=error: 429 Upstream Endpoint unavailable",
    "Pi ended with stopReason=error: 503 Endpoint is unavailable",
    "Codex error: Unable to verify model access right now. Please retry.",
    "Request timed out",
    "provider failed",
    "rate limit exceeded",
    "401 unauthorized",
    "authentication failed for api key",
  ];
  for (const message of cases) {
    assert.equal(
      isRetryableProviderFailure("runtime_exit_failed", message),
      true,
      message,
    );
  }
  assert.equal(
    isRetryableProviderFailure(
      "runtime_spawn_failed",
      "spawn failed: 503 upstream unavailable",
    ),
    true,
  );
});

test("isRetryableProviderFailure rejects non-supplier failures", () => {
  assert.equal(
    isRetryableProviderFailure(
      "runtime_timeout",
      "Beacon Run hard timeout after 30min",
    ),
    false,
  );
  assert.equal(
    isRetryableProviderFailure("outcome_missing", "No Final Outcome"),
    false,
  );
  assert.equal(
    isRetryableProviderFailure(
      "runtime_exit_failed",
      "Pi ended with stopReason=error: tool blew up",
    ),
    false,
  );
  assert.equal(
    isRetryableProviderFailure("capacity_exceeded", "queue full"),
    false,
  );
  assert.equal(
    isRetryableProviderFailure("service_interrupted", "restarted"),
    false,
  );
});

test("modelFallbackSessionId / attemptIndex round-trip", () => {
  assert.equal(modelFallbackSessionId("run_abc", 0), "run_abc");
  assert.equal(modelFallbackSessionId("run_abc", 1), "run_abc-fallback");
  assert.equal(modelFallbackSessionId("run_abc", 2), "run_abc-fallback-2");
  assert.equal(modelFallbackAttemptIndex("run_abc", undefined), 0);
  assert.equal(modelFallbackAttemptIndex("run_abc", "run_abc"), 0);
  assert.equal(modelFallbackAttemptIndex("run_abc", "run_abc-fallback"), 1);
  assert.equal(modelFallbackAttemptIndex("run_abc", "run_abc-fallback-2"), 2);
});

test("format helpers", () => {
  assert.equal(formatModelChoiceRef(luna), "openai-codex/gpt-6-luna/high");
  assert.equal(formatModelChoiceRef(flash), "opencode-go/deepseek-v4.1-flash");
  assert.match(
    formatFallbackChainExhaustedSummary([luna, grok], "boom"),
    /Primary model failed; fallback chain exhausted \(openai-codex\/gpt-6-luna\/high → xai\/grok-4\.7\/high\): boom/,
  );
});
