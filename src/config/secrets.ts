import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

const secretsSchema = z
  .object({
    version: z.literal(1),
    profiles: z.record(
      z.string(),
      z
        .object({
          feishu: z
            .object({
              app_id: z
                .string()
                .regex(/^cli_[0-9a-fA-F]{16}$/, "Invalid Feishu app_id"),
              app_secret: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

export type FeishuCredentials = {
  appId: string;
  appSecret: string;
};

export async function loadFeishuCredentials(
  profileId: string,
  path = join(homedir(), ".beacon", "secrets.json"),
): Promise<FeishuCredentials> {
  const metadata = await stat(path).catch((error: unknown) => {
    throw new Error(`Cannot inspect Beacon secrets file at ${path}`, {
      cause: error,
    });
  });
  if (!metadata.isFile())
    throw new Error(`Beacon secrets path is not a file: ${path}`);
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Beacon secrets file must have mode 0600: ${path}`);
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(
      `Beacon secrets file must be owned by the current user: ${path}`,
    );
  }
  const parent = await stat(dirname(path));
  if ((parent.mode & 0o077) !== 0) {
    throw new Error(
      `Beacon secrets parent directory must not grant group/world access: ${dirname(path)}`,
    );
  }
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read Beacon secrets file at ${path}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Beacon secrets file is not valid JSON: ${path}`, {
      cause: error,
    });
  }

  const secrets = secretsSchema.parse(parsed);
  const profile = secrets.profiles[profileId];
  if (!profile) {
    throw new Error(
      `No credentials configured for profile "${profileId}" in ${path}`,
    );
  }

  return {
    appId: profile.feishu.app_id,
    appSecret: profile.feishu.app_secret,
  };
}
