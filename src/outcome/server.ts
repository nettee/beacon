import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OutcomeBinding = {
  socketPath: string;
  runToken: string;
};

export type OutcomeSubmission = {
  binding: OutcomeBinding;
  take(): string;
  cancel(): void;
};

export type OutcomeSink = {
  openRun(): OutcomeSubmission;
};

export type OutcomeServer = OutcomeSink & {
  close(): Promise<void>;
};

type SubmissionRecord = { text?: string | undefined };

function respond(socket: Socket, response: object): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

export async function startOutcomeServer(
  options: { maxRequestBytes?: number | undefined } = {},
): Promise<OutcomeServer> {
  const maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new Error("Outcome request limit must be a positive integer");
  }
  const directory = await mkdtemp(join(tmpdir(), "beacon-outcomes-"));
  const socketPath = join(directory, "outcomes.sock");
  const submissions = new Map<string, SubmissionRecord>();

  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let finished = false;
    socket.on("data", (chunk: string) => {
      if (finished) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxRequestBytes) {
        finished = true;
        respond(socket, {
          ok: false,
          error: "Outcome submission request is too large",
        });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finished = true;

      let request: unknown;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        respond(socket, { ok: false, error: "invalid JSON request" });
        return;
      }
      if (
        typeof request !== "object" ||
        request === null ||
        !("runToken" in request) ||
        !("text" in request) ||
        typeof request.runToken !== "string" ||
        typeof request.text !== "string" ||
        !request.text.trim()
      ) {
        respond(socket, {
          ok: false,
          error: "runToken and non-empty text are required",
        });
        return;
      }

      const submission = submissions.get(request.runToken);
      if (!submission) {
        respond(socket, { ok: false, error: "unknown Run Capability" });
        return;
      }
      if (submission.text !== undefined) {
        respond(socket, {
          ok: false,
          error: "Final Outcome already submitted",
        });
        return;
      }
      submission.text = request.text;
      console.log("[beacon] Final Outcome submitted by Agent Runtime");
      respond(socket, { ok: true });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    openRun(): OutcomeSubmission {
      const runToken = randomBytes(32).toString("base64url");
      const record: SubmissionRecord = {};
      submissions.set(runToken, record);
      return {
        binding: { socketPath, runToken },
        take(): string {
          submissions.delete(runToken);
          if (record.text === undefined) {
            throw new Error(
              "Agent Runtime settled without submitting a Final Outcome",
            );
          }
          return record.text;
        },
        cancel(): void {
          submissions.delete(runToken);
        },
      };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}
