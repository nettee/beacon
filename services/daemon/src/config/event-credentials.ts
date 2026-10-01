import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { eventSourceSchema } from "../events/cloudevent.js";

const credentialsSchema = z
  .object({
    version: z.literal(1),
    producers: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
            token: z
              .string()
              .min(32)
              .regex(/^[A-Za-z0-9._~+/-]+=*$/),
            sources: z.array(eventSourceSchema).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type EventProducer = { id: string; token: string; sources: string[] };

export async function loadEventCredentials(
  path: string,
): Promise<EventProducer[]> {
  const canonicalParent = await realpath(dirname(path));
  const parent = await stat(canonicalParent);
  if (
    (parent.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && parent.uid !== process.getuid())
  ) {
    throw new Error(
      "Event credentials parent must be owned by the current user and grant no group/world access",
    );
  }
  if ((await lstat(path)).isSymbolicLink()) {
    throw new Error("Event credentials must not be a symbolic link");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid())
    ) {
      throw new Error(
        "Event credentials must be a regular file owned by the current user with mode 0600",
      );
    }
    // Deliberately omit parser causes: malformed JSON can quote credential bytes.
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error("Cannot read valid JSON event credentials");
    }
    const result = credentialsSchema.safeParse(parsed);
    if (!result.success)
      throw new Error("Invalid event credentials configuration");
    const ids = new Set<string>();
    const tokens = new Set<string>();
    for (const producer of result.data.producers) {
      if (ids.has(producer.id) || tokens.has(producer.token)) {
        throw new Error("Event producer IDs and tokens must be unique");
      }
      ids.add(producer.id);
      tokens.add(producer.token);
    }
    return result.data.producers;
  } finally {
    await file.close();
  }
}
