import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const cursorSchema = z
  .object({
    version: z.literal(1),
    scheduleId: z.string().min(1),
    through: z.string().datetime({ offset: true }),
  })
  .strict();

export type ScheduleCursor = z.infer<typeof cursorSchema>;

export class ScheduleCursorStore {
  private readonly root: string;

  constructor(profileDirectory: string) {
    this.root = join(profileDirectory, "state", "schedules");
  }

  private path(scheduleId: string): string {
    return join(this.root, `${scheduleId}.json`);
  }

  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(join(this.root, ".."), 0o700);
    await chmod(this.root, 0o700);
  }

  async read(scheduleId: string): Promise<ScheduleCursor | undefined> {
    await this.prepare();
    let raw: string;
    try {
      raw = await readFile(this.path(scheduleId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot read Schedule cursor ${scheduleId}`, { cause: error });
    }
    try {
      return cursorSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`Invalid Schedule cursor ${scheduleId}`, { cause: error });
    }
  }

  private async write(cursor: ScheduleCursor, exclusive = false): Promise<void> {
    await this.prepare();
    const target = this.path(cursor.scheduleId);
    const temporary = exclusive ? target : join(this.root, `.${cursor.scheduleId}-${randomUUID()}.tmp`);
    const handle = await open(temporary, exclusive ? "wx" : "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(cursor, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!exclusive) await rename(temporary, target);
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async initialize(scheduleId: string, through: Date): Promise<ScheduleCursor> {
    const cursor = cursorSchema.parse({ version: 1, scheduleId, through: through.toISOString() });
    try {
      await this.write(cursor, true);
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.read(scheduleId);
      if (!existing) throw new Error(`Schedule cursor disappeared: ${scheduleId}`);
      return existing;
    }
  }

  async advance(scheduleId: string, through: Date): Promise<ScheduleCursor> {
    const current = await this.read(scheduleId);
    if (!current) throw new Error(`Cannot advance missing Schedule cursor ${scheduleId}`);
    if (through.toISOString() < current.through) {
      throw new Error(`Schedule cursor cannot move backwards: ${scheduleId}`);
    }
    const next = cursorSchema.parse({ version: 1, scheduleId, through: through.toISOString() });
    await this.write(next);
    return next;
  }
}
