import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Profile } from "../../src/config/profile.js";
import type { TriggerRecord } from "../../src/domain/types.js";
import { createFeishuMessagePipeline } from "../../src/feishu/message-pipeline.js";
import { startOutcomeServer } from "../../src/outcome/server.js";
import { createPiRunOrchestrator } from "../../src/run/create-pi-orchestrator.js";
import { RunQueue } from "../../src/run/queue.js";
import { TriggerStore } from "../../src/state/trigger-store.js";
import {
  createInMemoryFeishuGateway,
  type ObservedDelivery,
} from "./in-memory-gateway.js";

export type MessageE2eResult = {
  intake: "accepted" | "duplicate" | "ignored";
  messageId: string;
  acknowledgedMessageIds: string[];
  deliveries: ObservedDelivery[];
  record: TriggerRecord;
};

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function executablePath(): Promise<string> {
  const configured = process.env.BEACON_E2E_MESSAGE_PI_EXECUTABLE;
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(
        "BEACON_E2E_MESSAGE_PI_EXECUTABLE must be an absolute path",
      );
    }
    await access(configured, constants.X_OK);
    return realpath(configured);
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "pi");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Keep searching PATH. Failure is reported if no executable is found.
    }
  }
  throw new Error(
    "Cannot find Pi executable; set BEACON_E2E_MESSAGE_PI_EXECUTABLE",
  );
}

async function codingAgentDirectory(): Promise<string> {
  const configured =
    process.env.BEACON_E2E_MESSAGE_PI_CODING_AGENT_DIRECTORY ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), ".pi", "agent");
  if (!isAbsolute(configured)) {
    throw new Error("Pi coding agent directory must be an absolute path");
  }
  const canonical = await realpath(configured);
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Pi coding agent path is not a directory: ${canonical}`);
  }
  return canonical;
}

export async function runMessageE2e(text: string): Promise<MessageE2eResult> {
  if (!text.trim()) throw new Error("Message E2E input must not be empty");

  const temporaryProfileDirectory = await mkdtemp(
    join(tmpdir(), "beacon-e2e-message-"),
  );
  const outcomes = await startOutcomeServer();
  try {
    const profile: Profile = {
      id: "e2e-message",
      directory: temporaryProfileDirectory,
      prompt: [
        "You are the Beacon Message E2E echo Profile.",
        "Read the text in current_message.content from the Feishu Trigger JSON.",
        "Submit that exact text three times, separated by newline characters.",
        "Do not add numbering, quotes, explanations, or any other text.",
      ].join(" "),
      workspace: repositoryRoot,
      runtime: "pi",
      model: {
        provider: process.env.BEACON_E2E_MESSAGE_PROVIDER ?? "openai-codex",
        id: process.env.BEACON_E2E_MESSAGE_MODEL ?? "gpt-5.6-luna:low",
      },
      schedules: [],
    };
    const piExecutable = await executablePath();
    const piDirectory = await codingAgentDirectory();
    const store = new TriggerStore(profile.directory, profile.id);
    const { gateway, client } = createInMemoryFeishuGateway();
    const orchestrator = createPiRunOrchestrator({
      config: {
        pi: {
          executable: piExecutable,
          codingAgentDirectory: piDirectory,
          sessionDirectory: join(temporaryProfileDirectory, "sessions"),
        },
        runs: {
          maxConcurrent: 1,
          maxQueued: 0,
          timeoutSeconds: 180,
          terminateGraceSeconds: 5,
        },
      },
      profile,
      store,
      queue: new RunQueue(1, 0),
      outcomes,
      delivery: gateway,
    });
    let fatalError: Error | undefined;
    const pipeline = createFeishuMessagePipeline({
      gateway,
      store,
      process: (triggerKey, normalize) =>
        orchestrator.process(triggerKey, normalize),
      onFatal(error) {
        fatalError = error;
      },
    });
    let stopGateway!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      stopGateway = resolve;
    });
    const runningGateway = pipeline.run(shutdown);
    let intakeResult: "accepted" | "duplicate" | "ignored";
    let messageId: string;
    try {
      ({ intake: intakeResult, messageId } = await client.send(text));
      await pipeline.drain();
      if (fatalError) throw fatalError;
    } finally {
      stopGateway();
      await runningGateway;
    }

    const records = await store.list();
    if (records.length !== 1 || !records[0]) {
      throw new Error(
        `Message E2E expected one Trigger record, received ${records.length}`,
      );
    }
    return {
      intake: intakeResult,
      messageId,
      acknowledgedMessageIds: client.acknowledgedMessageIds(),
      deliveries: client.deliveries(),
      record: records[0],
    };
  } finally {
    try {
      await outcomes.close();
    } finally {
      await rm(temporaryProfileDirectory, { recursive: true, force: true });
    }
  }
}
