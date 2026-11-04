import { createConnection } from "node:net";

import type { FinalOutcomeContent } from "../domain/types.js";
import {
  completeOutcome,
  mergeOutcome,
  type OutcomePatch,
  parseOutcomePatch,
} from "./content.js";

type SubmitResponse = { ok: boolean; error?: string | undefined };

async function submitOutcomeOnce(
  socketPath: string,
  runToken: string,
  patch: OutcomePatch,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let responseBuffer = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ runToken, outcome: patch })}\n`);
    });
    socket.on("data", (chunk: string) => {
      responseBuffer += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => {
      let response: SubmitResponse;
      try {
        response = JSON.parse(responseBuffer) as SubmitResponse;
      } catch (error) {
        reject(
          new Error("Beacon returned an invalid outcome-submission response", {
            cause: error,
          }),
        );
        return;
      }
      if (!response.ok) {
        reject(
          new Error(response.error ?? "Beacon rejected the Final Outcome"),
        );
        return;
      }
      resolve();
    });
  });
}

function isRetryableSubmitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  );
}

/**
 * Submit a Final Outcome patch. Retries briefly on connection errors so a
 * detached Pi worker can survive a short Beacon restart window.
 */
export async function submitOutcome(
  socketPath: string,
  runToken: string,
  outcome: OutcomePatch | FinalOutcomeContent,
  options: {
    retries?: number | undefined;
    retryDelayMs?: number | undefined;
  } = {},
): Promise<void> {
  const patch = parseOutcomePatch(outcome);
  const retries = options.retries ?? 40;
  const retryDelayMs = options.retryDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await submitOutcomeOnce(socketPath, runToken, patch);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryableSubmitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw lastError;
}

export async function submitOutcomeFromCli(): Promise<void> {
  const socketPath = process.env.BEACON_OUTCOME_SOCKET;
  const runToken = process.env.BEACON_RUN_TOKEN;
  if (!socketPath || !runToken) {
    throw new Error("This command must run inside a Beacon-managed Agent Run");
  }
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let patch: OutcomePatch;
  try {
    patch = parseOutcomePatch(JSON.parse(input));
  } catch (error) {
    throw new Error("Final Outcome stdin must be valid outcome JSON", {
      cause: error,
    });
  }
  await submitOutcome(socketPath, runToken, patch);
  console.log("Final Outcome accepted by Beacon");
}

export type FeedbackSubmitItem = {
  priority: "high" | "medium";
  summary: string;
};

/**
 * Beacon Feedback sugar over the same Outcome socket/patch as
 * `beacon outcome submit`. Prefer Pi `submit_feedback` on current fleets.
 */
export async function submitFeedbackFromCli(
  item?: FeedbackSubmitItem,
): Promise<void> {
  const socketPath = process.env.BEACON_OUTCOME_SOCKET;
  const runToken = process.env.BEACON_RUN_TOKEN;
  if (!socketPath || !runToken) {
    throw new Error("This command must run inside a Beacon-managed Agent Run");
  }

  let patch: OutcomePatch;
  if (item) {
    try {
      patch = parseOutcomePatch({ feedback: { items: [item] } });
    } catch (error) {
      throw new Error(
        "Feedback flags must be a valid high/medium item with a non-blank summary",
        { cause: error },
      );
    }
  } else {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new Error(
        'Feedback stdin must be JSON: { "items": [...] } or a full outcome patch with feedback',
        { cause: error },
      );
    }
    try {
      if (
        parsed &&
        typeof parsed === "object" &&
        "items" in parsed &&
        !("feedback" in parsed) &&
        !("reply" in parsed) &&
        !("notify" in parsed) &&
        !("observabilityFeedback" in parsed)
      ) {
        patch = parseOutcomePatch({
          feedback: parsed as { items: FeedbackSubmitItem[] },
        });
      } else {
        patch = parseOutcomePatch(parsed);
      }
    } catch (error) {
      throw new Error(
        "Feedback stdin must be valid feedback items or outcome JSON",
        { cause: error },
      );
    }
    if (!patch.feedback) {
      throw new Error(
        "Feedback stdin must include feedback items (use beacon outcome submit for other patches)",
      );
    }
  }

  await submitOutcome(socketPath, runToken, patch);
  console.log("Feedback accepted by Beacon");
}

export { completeOutcome, mergeOutcome };
