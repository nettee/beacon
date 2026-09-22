import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  type DeliveryTarget,
  failureCodes,
  type TriggerRecord,
} from "../domain/types.js";
import {
  finalOutcomeContentSchema,
  parseFinalOutcomeContent,
} from "../outcome/content.js";

const timestamp = z.string().datetime({ offset: true });
const failureSchema = z
  .object({ code: z.enum(failureCodes), summary: z.string().min(1).max(4096) })
  .strict();
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), messageId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("chat"), chatId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("local_stdout") }).strict(),
]);
const messageSchema = z
  .object({
    messageId: z.string().min(1),
    messageType: z.string().min(1),
    senderType: z.string().min(1),
    senderId: z.string().min(1).optional(),
    content: z.unknown(),
  })
  .strict();
const inputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("feishu_message"),
      eventId: z.string().min(1),
      chatType: z.enum(["p2p", "group"]),
      quotedMessages: z.array(messageSchema),
      currentMessage: messageSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule"),
      scheduleId: z.string().min(1),
      scheduledFor: timestamp,
      text: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("manual"), text: z.string().min(1) }).strict(),
]);
const runSchema = z
  .object({
    runId: z.string().min(1),
    sessionId: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
      .optional(),
    sessionPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "Pi session path must be absolute")
      .optional(),
    state: z.enum(["queued", "starting", "running", "succeeded", "failed"]),
    queuedAt: timestamp,
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    workspace: z.string().min(1),
    promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    systemPrompt: z.string().min(1).optional(),
    failure: failureSchema.optional(),
  })
  .strict();
const outcomeSchema = z.union([
  z
    .object({
      origin: z.enum(["agent", "beacon_failure"]),
      content: z.preprocess((value) => {
        try {
          return parseFinalOutcomeContent(value);
        } catch {
          return value;
        }
      }, finalOutcomeContentSchema),
      submittedAt: timestamp,
    })
    .strict(),
  z
    .object({
      origin: z.enum(["agent", "beacon_failure"]),
      text: z.string().min(1),
      submittedAt: timestamp,
    })
    .strict()
    .transform(({ origin, text, submittedAt }) => ({
      origin,
      content: { reply: { kind: "text" as const, text } },
      submittedAt,
    })),
]);
const deliverySchema = z
  .object({
    deliveryId: z.string().min(1),
    target: targetSchema,
    state: z.enum(["pending", "delivering", "delivered", "failed"]),
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    providerRequestId: z.string().min(1).optional(),
    failure: failureSchema.optional(),
  })
  .strict();
const triggerRecordSchema = z
  .object({
    version: z.literal(1),
    triggerKey: z.string().regex(/^[a-f0-9]{64}$/),
    triggerId: z.string().min(1),
    profileId: z.string().min(1),
    sourceKey: z.array(z.string().min(1)).min(2),
    acceptedAt: timestamp,
    target: targetSchema,
    notifyTarget: targetSchema.optional(),
    input: inputSchema.optional(),
    ingress: z.record(z.string(), z.unknown()).optional(),
    run: runSchema.optional(),
    finalOutcome: outcomeSchema.optional(),
    delivery: deliverySchema.optional(),
    notifyDelivery: deliverySchema.optional(),
  })
  .strict();

export type TriggerClaim = {
  sourceKey: string[];
  target: DeliveryTarget;
  notifyTarget?: DeliveryTarget | undefined;
  ingress?: Record<string, unknown> | undefined;
  acceptedAt?: Date | undefined;
};

function keyFor(profileId: string, sourceKey: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["beacon-trigger-v1", profileId, ...sourceKey]))
    .digest("hex");
}

function validateRecord(value: unknown): TriggerRecord {
  const record = triggerRecordSchema.parse(value) as TriggerRecord;
  if (
    record.run &&
    (record.run.sessionId === undefined) !==
      (record.run.sessionPath === undefined)
  ) {
    throw new Error(
      "Run record must contain both Pi sessionId and sessionPath or neither",
    );
  }
  if (
    record.run?.sessionId &&
    (record.run.sessionId !== record.run.runId ||
      basename(record.run.sessionPath!) !== record.run.runId ||
      basename(dirname(record.run.sessionPath!)) !== record.profileId)
  ) {
    throw new Error(
      "Run Pi session identity must map to its Profile ID and Run ID",
    );
  }
  if (record.delivery && !record.finalOutcome) {
    throw new Error(
      "Trigger record with Delivery must contain a Final Outcome",
    );
  }
  if (record.notifyDelivery && !record.finalOutcome) {
    throw new Error(
      "Trigger record with notify Delivery must contain a Final Outcome",
    );
  }
  if (
    record.delivery &&
    record.finalOutcome?.content.reply.kind === "no_reply"
  ) {
    throw new Error("no_reply Outcomes must not have a reply Delivery");
  }
  if (record.notifyDelivery && !record.finalOutcome?.content.notify) {
    throw new Error("notify Delivery requires a notify card");
  }
  if (record.notifyDelivery && !record.notifyTarget) {
    throw new Error("notify Delivery requires a notify target");
  }
  if (
    record.run?.state === "succeeded" &&
    record.finalOutcome?.origin !== "agent"
  ) {
    throw new Error("Succeeded Run must contain an Agent Final Outcome");
  }
  if (record.run?.state === "failed" && !record.run.failure) {
    throw new Error("Failed Run must contain failure details");
  }
  return record;
}

export class TriggerStore {
  readonly root: string;

  constructor(
    profileDirectory: string,
    private readonly profileId: string,
  ) {
    this.root = join(profileDirectory, "state", "triggers");
  }

  recordPath(triggerKey: string): string {
    return join(this.root, triggerKey, "record.json");
  }

  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(join(this.root, ".."), 0o700);
    await chmod(this.root, 0o700);
  }

  private async read(triggerKey: string): Promise<TriggerRecord> {
    const path = this.recordPath(triggerKey);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`Cannot read Trigger record at ${path}`, {
        cause: error,
      });
    }
    try {
      return validateRecord(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`Cannot parse Trigger record at ${path}`, {
        cause: error,
      });
    }
  }

  private async readConcurrentClaim(
    triggerKey: string,
  ): Promise<TriggerRecord> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await this.read(triggerKey);
      } catch (error) {
        const cause =
          error instanceof Error
            ? (error.cause as NodeJS.ErrnoException | undefined)
            : undefined;
        if (cause?.code !== "ENOENT") throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
    return this.read(triggerKey);
  }

  private async write(
    triggerKey: string,
    record: TriggerRecord,
  ): Promise<void> {
    const validated = validateRecord(record);
    const directory = join(this.root, triggerKey);
    const temporary = join(directory, `.record-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.recordPath(triggerKey));
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  async claim(
    request: TriggerClaim,
  ): Promise<{ created: boolean; record: TriggerRecord }> {
    if (
      request.sourceKey.length < 2 ||
      request.sourceKey.some((part) => !part)
    ) {
      throw new Error(
        "Trigger source key must contain at least two non-empty parts",
      );
    }
    await this.prepare();
    const triggerKey = keyFor(this.profileId, request.sourceKey);
    const directory = join(this.root, triggerKey);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          created: false,
          record: await this.readConcurrentClaim(triggerKey),
        };
      }
      throw new Error(`Cannot claim Trigger ${triggerKey}`, { cause: error });
    }

    const record: TriggerRecord = {
      version: 1,
      triggerKey,
      triggerId: `trg_${triggerKey.slice(0, 24)}`,
      profileId: this.profileId,
      sourceKey: [...request.sourceKey],
      acceptedAt: (request.acceptedAt ?? new Date()).toISOString(),
      target: request.target,
      ...(request.notifyTarget ? { notifyTarget: request.notifyTarget } : {}),
      ...(request.ingress ? { ingress: request.ingress } : {}),
    };
    await this.write(triggerKey, record);
    return { created: true, record };
  }

  async update(
    triggerKey: string,
    transform: (record: TriggerRecord) => TriggerRecord,
  ): Promise<TriggerRecord> {
    const current = await this.read(triggerKey);
    const next = transform(structuredClone(current));
    if (next.triggerKey !== triggerKey || next.profileId !== this.profileId) {
      throw new Error("Trigger identity cannot change during update");
    }
    await this.write(triggerKey, next);
    return next;
  }

  async list(): Promise<TriggerRecord[]> {
    await this.prepare();
    const entries = await readdir(this.root, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.read(entry.name)),
    );
    return records.sort(
      (left, right) =>
        left.acceptedAt.localeCompare(right.acceptedAt) ||
        left.triggerId.localeCompare(right.triggerId),
    );
  }
}
