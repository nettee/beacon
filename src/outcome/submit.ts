import { createConnection } from "node:net";

type SubmitResponse = { ok: boolean; error?: string | undefined };

export async function submitOutcome(
  socketPath: string,
  runToken: string,
  text: string,
): Promise<void> {
  if (!text.trim()) throw new Error("Final Outcome must not be empty");

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let responseBuffer = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ runToken, text })}\n`);
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
        reject(new Error("Beacon returned an invalid outcome-submission response", { cause: error }));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error ?? "Beacon rejected the Final Outcome"));
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
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  await submitOutcome(socketPath, runToken, text);
  console.log("Final Outcome accepted by Beacon");
}
