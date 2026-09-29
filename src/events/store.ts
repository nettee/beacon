import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type CloudEvent, cloudEventSchema } from "./cloudevent.js";

const recipientSchema = z
  .object({
    profileId: z.string().min(1),
    chatId: z.string().min(1),
    notifyChatId: z.string().min(1).optional(),
    triggerId: z.string().min(1).optional(),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    receiptId: z.string().regex(/^evt_[a-f0-9]{64}$/),
    producerId: z.string().min(1),
    acceptedAt: z.string().datetime({ offset: true }),
    event: cloudEventSchema,
    recipients: z.array(recipientSchema),
  })
  .strict();
export type EventRecipient = z.infer<typeof recipientSchema>;
export type EventRecord = z.infer<typeof recordSchema>;

export class EventIntakeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function receiptId(event: CloudEvent): string {
  return `evt_${createHash("sha256")
    .update(JSON.stringify([event.source, event.id]))
    .digest("hex")}`;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value)!;
}
export function eventStatus(
  record: EventRecord,
): "unmatched" | "pending" | "dispatched" {
  if (!record.recipients.length) return "unmatched";
  return record.recipients.every((recipient) => recipient.triggerId)
    ? "dispatched"
    : "pending";
}

/** Single service owner; serialized read/modify/write, atomic durable snapshots. */
export class EventStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // A failed request must not poison subsequent independent operations.
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }
  private path(id: string): string {
    if (!/^evt_[a-f0-9]{64}$/.test(id))
      throw new EventIntakeError(404, "Unknown event receipt");
    return join(this.directory, `${id}.json`);
  }
  private async read(id: string): Promise<EventRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const record = recordSchema.parse(JSON.parse(raw));
    if (
      record.receiptId !== id ||
      receiptId(record.event) !== id ||
      new Set(record.recipients.map((r) => r.profileId)).size !==
        record.recipients.length
    ) {
      throw new Error(`Invalid Event identity or recipients: ${id}`);
    }
    return record;
  }
  private async records(): Promise<EventRecord[]> {
    await this.prepare();
    const result: EventRecord[] = [];
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const record = await this.read(file.slice(0, -5));
      if (!record) throw new Error(`Event disappeared: ${file}`);
      result.push(record);
    }
    return result.sort(
      (a, b) =>
        a.acceptedAt.localeCompare(b.acceptedAt) ||
        a.receiptId.localeCompare(b.receiptId),
    );
  }
  private async write(record: EventRecord, create: boolean): Promise<void> {
    recordSchema.parse(record);
    const temporary = join(this.directory, `.event-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (create) {
      await link(temporary, this.path(record.receiptId));
      await unlink(temporary);
    } else {
      await rename(temporary, this.path(record.receiptId));
    }
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async accept(
    event: CloudEvent,
    producerId: string,
    recipients: EventRecipient[],
    maxPending: number,
  ): Promise<{ created: boolean; record: EventRecord }> {
    return this.exclusive(async () => {
      await this.prepare();
      const id = receiptId(event);
      const existing = await this.read(id);
      if (existing) {
        if (
          existing.producerId !== producerId ||
          canonical(existing.event) !== canonical(event)
        ) {
          throw new EventIntakeError(
            409,
            "Event source and id already identify a different submission",
          );
        }
        return { created: false, record: existing };
      }
      if (
        (await this.records()).filter((r) => eventStatus(r) === "pending")
          .length >= maxPending
      ) {
        throw new EventIntakeError(
          503,
          "Event inbox capacity exceeded; retry later",
        );
      }
      const record: EventRecord = {
        version: 1,
        receiptId: id,
        producerId,
        acceptedAt: new Date().toISOString(),
        event,
        recipients,
      };
      await this.write(record, true);
      return { created: true, record };
    });
  }
  get(id: string): Promise<EventRecord | undefined> {
    return this.exclusive(() => this.read(id));
  }
  pending(): Promise<EventRecord[]> {
    return this.exclusive(async () =>
      (await this.records()).filter((r) => eventStatus(r) === "pending"),
    );
  }
  markDispatched(
    id: string,
    profileId: string,
    triggerId: string,
  ): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.read(id);
      if (!record) throw new Error(`Missing Event ${id}`);
      const recipient = record.recipients.find(
        (r) => r.profileId === profileId,
      );
      if (!recipient) throw new Error(`Missing Event recipient ${profileId}`);
      if (recipient.triggerId && recipient.triggerId !== triggerId)
        throw new Error("Event Trigger identity changed");
      recipient.triggerId = triggerId;
      await this.write(record, false);
    });
  }
}
