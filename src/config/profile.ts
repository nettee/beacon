import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";
import { nextOccurrence } from "../schedule/cron.js";
import { parseStrictYaml } from "./yaml.js";

const profileIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

const scheduleSchema = z
  .object({
    id: z.string().regex(profileIdPattern),
    cron: z
      .string()
      .trim()
      .refine((value) => value.split(/\s+/).length === 5, {
        message: "Schedule cron must contain exactly five fields",
      }),
    timezone: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }, "Schedule timezone must be a valid IANA timezone"),
    input: z.string().trim().min(1),
    delivery: z.object({ chat_id: z.string().trim().min(1) }).strict(),
  })
  .strict();

const profileDocumentSchema = z
  .object({
    prompt: z.string().min(1),
    workspace: z.string().min(1),
    runtime: z.literal("pi"),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
      })
      .strict(),
    schedules: z.array(scheduleSchema).default([]),
  })
  .strict();

export type Profile = {
  id: string;
  directory: string;
  prompt: string;
  workspace: string;
  runtime: "pi";
  model: {
    provider: string;
    id: string;
  };
  schedules: Array<{
    id: string;
    cron: string;
    timezone: string;
    input: string;
    delivery: { chatId: string };
  }>;
};

function assertProfileId(profileId: string): void {
  if (!profileIdPattern.test(profileId)) {
    throw new Error(`Invalid Profile ID: ${JSON.stringify(profileId)}`);
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function loadProfile(
  profileId: string,
  profilesDirectory = join(homedir(), ".beacon", "profiles"),
): Promise<Profile> {
  assertProfileId(profileId);
  const profileDirectory = join(profilesDirectory, profileId);
  const configPath = join(profileDirectory, "profile.yaml");

  const config = profileDocumentSchema.parse(await parseStrictYaml(configPath));
  const scheduleIds = new Set<string>();
  for (const schedule of config.schedules) {
    if (scheduleIds.has(schedule.id)) {
      throw new Error(
        `Duplicate Schedule ID in Profile ${profileId}: ${schedule.id}`,
      );
    }
    scheduleIds.add(schedule.id);
    try {
      nextOccurrence(schedule.cron, schedule.timezone, new Date(0));
    } catch (error) {
      throw new Error(
        `Invalid Schedule cron in Profile ${profileId}: ${schedule.id}`,
        {
          cause: error,
        },
      );
    }
  }
  if (isAbsolute(config.prompt)) {
    throw new Error(
      `Profile prompt path must be relative to ${profileDirectory}`,
    );
  }

  const promptPath = resolve(profileDirectory, config.prompt);
  const canonicalProfileDirectory = await realpath(profileDirectory);
  let canonicalPromptPath: string;
  try {
    canonicalPromptPath = await realpath(promptPath);
  } catch (error) {
    throw new Error(`Cannot read Profile prompt at ${promptPath}`, {
      cause: error,
    });
  }
  if (!isWithin(canonicalProfileDirectory, canonicalPromptPath)) {
    throw new Error(
      `Profile prompt must stay inside ${canonicalProfileDirectory}`,
    );
  }

  const prompt = (await readFile(canonicalPromptPath, "utf8")).trim();
  if (!prompt)
    throw new Error(`Profile prompt must not be empty: ${canonicalPromptPath}`);

  const workspace = isAbsolute(config.workspace)
    ? config.workspace
    : resolve(dirname(configPath), config.workspace);
  let workspaceStat: Awaited<ReturnType<typeof stat>>;
  try {
    workspaceStat = await stat(workspace);
  } catch (error) {
    throw new Error(`Cannot access Profile workspace at ${workspace}`, {
      cause: error,
    });
  }
  if (!workspaceStat.isDirectory()) {
    throw new Error(`Profile workspace is not a directory: ${workspace}`);
  }

  return {
    id: profileId,
    directory: canonicalProfileDirectory,
    prompt,
    workspace,
    runtime: config.runtime,
    model: config.model,
    schedules: config.schedules.map((schedule) => ({
      id: schedule.id,
      cron: schedule.cron,
      timezone: schedule.timezone,
      input: schedule.input,
      delivery: { chatId: schedule.delivery.chat_id },
    })),
  };
}
