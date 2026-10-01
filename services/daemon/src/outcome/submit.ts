import { createConnection } from "node:net";

import type { FinalOutcomeContent } from "../domain/types.js";
import {
  completeOutcome,
  mergeOutcome,
  type OutcomePatch,
  parseOutcomePatch,
} from "./content.js";

type SubmitResponse = { ok: boolean; error?: string | undefined };

export async function submitOutcome(
  socketPath: string,
  runToken: string,
  outcome: OutcomePatch | FinalOutcomeContent,
): Promise<void> {
  const patch = parseOutcomePatch(outcome);

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

export { completeOutcome, mergeOutcome };
