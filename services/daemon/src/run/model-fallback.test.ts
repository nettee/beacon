import assert from "node:assert/strict";
import test from "node:test";

import {
  HARDCODED_MODEL_FALLBACK,
  isHardcodedFallbackModel,
  isRetryableProviderFailure,
  modelFallbackSessionId,
} from "./model-fallback.js";

test("HARDCODED_MODEL_FALLBACK is xai / grok-4.7 / high", () => {
  assert.deepEqual(HARDCODED_MODEL_FALLBACK, {
    provider: "xai",
    id: "grok-4.7",
    thinking: "high",
  });
});

test("isHardcodedFallbackModel matches provider+id+thinking", () => {
  assert.equal(
    isHardcodedFallbackModel({
      provider: "xai",
      model: "grok-4.7",
      thinking: "high",
    }),
    true,
  );
  assert.equal(
    isHardcodedFallbackModel({
      provider: "xai",
      model: "grok-4.7",
    }),
    false,
  );
  assert.equal(
    isHardcodedFallbackModel({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
    }),
    false,
  );
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

test("modelFallbackSessionId suffixes the run id", () => {
  assert.equal(modelFallbackSessionId("run_abc"), "run_abc-fallback");
});
