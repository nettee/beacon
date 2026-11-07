import type { ProfileModelChoice } from "../config/model-pool.js";
import type { FailureCode } from "../domain/types.js";

/**
 * Hardcoded provider/model fallback when the Profile's selected model hits a
 * retryable supplier/API error. Temporary fixed chain (BCN-37) — not config.
 */
export const HARDCODED_MODEL_FALLBACK = {
  provider: "xai",
  id: "grok-4.7",
  thinking: "high",
} as const satisfies ProfileModelChoice;

export type ModelFallbackChoice = typeof HARDCODED_MODEL_FALLBACK;

/** True when the Run is already on the hardcoded fallback model. */
export function isHardcodedFallbackModel(run: {
  provider: string;
  model: string;
  thinking?: string | undefined;
}): boolean {
  return (
    run.provider === HARDCODED_MODEL_FALLBACK.provider &&
    run.model === HARDCODED_MODEL_FALLBACK.id &&
    (run.thinking ?? undefined) === HARDCODED_MODEL_FALLBACK.thinking
  );
}

/**
 * Supplier / model errors that warrant a one-shot Grok retry.
 *
 * Only `runtime_exit_failed` and `runtime_spawn_failed` are candidates;
 * timeouts, outcome contract misses, and local protocol errors are not.
 */
export function isRetryableProviderFailure(
  code: FailureCode | string,
  message: string,
): boolean {
  if (code !== "runtime_exit_failed" && code !== "runtime_spawn_failed") {
    return false;
  }
  const text = message.toLowerCase();
  return (
    /\b429\b/.test(text) ||
    /\b503\b/.test(text) ||
    /\b502\b/.test(text) ||
    /\b500\b/.test(text) ||
    /\b401\b/.test(text) ||
    /\b403\b/.test(text) ||
    /rate[\s_-]?limit/.test(text) ||
    /endpoint[\s\S]{0,40}(unavailable|overloaded)/.test(text) ||
    /upstream[\s\S]{0,40}(unavailable|error|timeout|overloaded)/.test(text) ||
    /unable to verify model access/.test(text) ||
    /request timed out/.test(text) ||
    /overloaded/.test(text) ||
    /authentication/.test(text) ||
    /unauthorized/.test(text) ||
    /forbidden/.test(text) ||
    /model[\s\S]{0,40}(not available|unavailable|access)/.test(text) ||
    /provider[\s\S]{0,20}(error|failed|unavailable)/.test(text) ||
    /codex error/.test(text)
  );
}

/** Session id / path suffix for the fallback attempt within the same Run. */
export const MODEL_FALLBACK_SESSION_SUFFIX = "-fallback";

export function modelFallbackSessionId(runId: string): string {
  return `${runId}${MODEL_FALLBACK_SESSION_SUFFIX}`;
}
