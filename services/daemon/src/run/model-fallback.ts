import type { ProfileModelChoice } from "../config/model-pool.js";
import type { FailureCode } from "../domain/types.js";

/** Max models in a Profile `model_fallback_chain` (primary slot + fallbacks). */
export const MAX_MODEL_FALLBACK_CHAIN = 3;

/**
 * Format `provider/id[/thinking]` for logs and failure summaries.
 */
export function formatModelChoiceRef(choice: {
  provider: string;
  id: string;
  thinking?: string | undefined;
}): string {
  return choice.thinking
    ? `${choice.provider}/${choice.id}/${choice.thinking}`
    : `${choice.provider}/${choice.id}`;
}

export function sameModelChoice(
  left: {
    provider: string;
    id: string;
    thinking?: string | undefined;
  },
  right: {
    provider: string;
    id: string;
    thinking?: string | undefined;
  },
): boolean {
  return (
    left.provider === right.provider &&
    left.id === right.id &&
    (left.thinking ?? undefined) === (right.thinking ?? undefined)
  );
}

/**
 * Resolve the next model in a configured fallback chain.
 *
 * Chain semantics (length 0–3):
 * - unset / empty / length 1 → no fallback (primary only)
 * - length 2–3 → after attempt `N` fails, retry with `chain[N+1]` (same Run)
 *
 * Index 0 is the declared primary slot (usually matches Dashboard primary).
 * The first Run attempt still comes from `model` / `model_pool`; on failure we
 * advance through `chain[1..]`.
 */
export function nextModelFallbackChoice(
  chain: readonly ProfileModelChoice[] | undefined,
  attemptIndex: number,
): { choice: ProfileModelChoice; nextAttemptIndex: number } | undefined {
  if (!chain || chain.length <= 1) return undefined;
  if (attemptIndex < 0) return undefined;
  const nextAttemptIndex = attemptIndex + 1;
  if (nextAttemptIndex >= chain.length) return undefined;
  const choice = chain[nextAttemptIndex];
  if (!choice) return undefined;
  return { choice, nextAttemptIndex };
}

/**
 * Supplier / model errors that warrant advancing the fallback chain.
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

/** Session id / path suffix for fallback attempt 1 within the same Run. */
export const MODEL_FALLBACK_SESSION_SUFFIX = "-fallback";

/**
 * Session id for a fallback attempt.
 * Attempt 1 → `{runId}-fallback` (compat with #225); attempt 2 → `{runId}-fallback-2`.
 */
export function modelFallbackSessionId(
  runId: string,
  attemptIndex: number,
): string {
  if (attemptIndex <= 0) return runId;
  if (attemptIndex === 1) return `${runId}${MODEL_FALLBACK_SESSION_SUFFIX}`;
  return `${runId}${MODEL_FALLBACK_SESSION_SUFFIX}-${String(attemptIndex)}`;
}

/**
 * Infer which fallback-chain attempt the Run is on from its session id.
 * Primary → 0; first fallback → 1; second → 2.
 */
export function modelFallbackAttemptIndex(
  runId: string,
  sessionId: string | undefined,
): number {
  if (!sessionId || sessionId === runId) return 0;
  if (sessionId === `${runId}${MODEL_FALLBACK_SESSION_SUFFIX}`) return 1;
  const prefix = `${runId}${MODEL_FALLBACK_SESSION_SUFFIX}-`;
  if (sessionId.startsWith(prefix)) {
    const raw = sessionId.slice(prefix.length);
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  return 0;
}

/** Failure summary prefix when the configured chain is exhausted. */
export function formatFallbackChainExhaustedSummary(
  chain: readonly ProfileModelChoice[],
  detail: string,
): string {
  const refs = chain.map((entry) => formatModelChoiceRef(entry)).join(" → ");
  return `Primary model failed; fallback chain exhausted (${refs}): ${detail}`;
}
