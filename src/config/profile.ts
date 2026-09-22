import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";
import { nextOccurrence } from "../schedule/cron.js";
import { parseStrictYaml } from "./yaml.js";

const profileIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

export const profilePersonaFile = "persona.md";
export const profileTaskFile = "task.md";
export const workspaceProfileDirectoryName = ".beacon-profile";

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
    notify: z
      .object({ chat_id: z.string().trim().min(1) })
      .strict()
      .optional(),
  })
  .strict();

const profileDocumentSchema = z
  .object({
    workspace: z.string().min(1),
    runtime: z.literal("pi"),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
      })
      .strict(),
    admin: z
      .object({ chat_id: z.string().trim().min(1) })
      .strict()
      .optional(),
    schedules: z.array(scheduleSchema).default([]),
  })
  .strict();

export type Profile = {
  id: string;
  directory: string;
  persona: string;
  task: string;
  workspace: string;
  runtime: "pi";
  model: {
    provider: string;
    id: string;
  };
  admin?: { chatId: string } | undefined;
  schedules: Array<{
    id: string;
    cron: string;
    timezone: string;
    input: string;
    notify?: { chatId: string } | undefined;
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

export function workspaceProfileDirectory(workspace: string): string {
  return join(workspace, workspaceProfileDirectoryName);
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function markdownPairPaths(directory: string): {
  persona: string;
  task: string;
} {
  return {
    persona: join(directory, profilePersonaFile),
    task: join(directory, profileTaskFile),
  };
}

async function missingMarkdownPaths(directory: string): Promise<string[]> {
  const paths = markdownPairPaths(directory);
  const missing: string[] = [];
  if (!(await isExistingFile(paths.persona))) missing.push(paths.persona);
  if (!(await isExistingFile(paths.task))) missing.push(paths.task);
  return missing;
}

async function markdownPairExists(directory: string): Promise<boolean> {
  return (await missingMarkdownPaths(directory)).length === 0;
}

async function loadRequiredMarkdown(
  canonicalDirectory: string,
  filename: typeof profilePersonaFile | typeof profileTaskFile,
): Promise<string> {
  const filePath = join(canonicalDirectory, filename);
  let canonicalFilePath: string;
  try {
    canonicalFilePath = await realpath(filePath);
  } catch (error) {
    throw new Error(`Cannot read Profile ${filename} at ${filePath}`, {
      cause: error,
    });
  }
  if (!isWithin(canonicalDirectory, canonicalFilePath)) {
    throw new Error(
      `Profile ${filename} must stay inside ${canonicalDirectory}`,
    );
  }
  const text = (await readFile(canonicalFilePath, "utf8")).trim();
  if (!text) {
    throw new Error(
      `Profile ${filename} must not be empty: ${canonicalFilePath}`,
    );
  }
  return text;
}

async function loadMarkdownPair(
  directory: string,
  boundary: string,
): Promise<{ persona: string; task: string }> {
  const canonicalBoundary = await realpath(boundary);
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(directory);
  } catch (error) {
    throw new Error(`Cannot read Profile markdown at ${directory}`, {
      cause: error,
    });
  }
  if (!isWithin(canonicalBoundary, canonicalDirectory)) {
    throw new Error(`Profile markdown must stay inside ${canonicalBoundary}`);
  }
  return {
    persona: await loadRequiredMarkdown(canonicalDirectory, profilePersonaFile),
    task: await loadRequiredMarkdown(canonicalDirectory, profileTaskFile),
  };
}

async function loadPersonaAndTask(
  profileId: string,
  workspace: string,
  profileDirectory: string,
): Promise<{ persona: string; task: string }> {
  const workspaceDirectory = workspaceProfileDirectory(workspace);
  if (await markdownPairExists(workspaceDirectory)) {
    return loadMarkdownPair(workspaceDirectory, workspace);
  }
  if (await markdownPairExists(profileDirectory)) {
    return loadMarkdownPair(profileDirectory, profileDirectory);
  }
  const missing = [
    ...(await missingMarkdownPaths(workspaceDirectory)),
    ...(await missingMarkdownPaths(profileDirectory)),
  ];
  throw new Error(
    `Profile ${profileId} has no complete ${profilePersonaFile} + ${profileTaskFile} pair. Missing: ${missing.join(", ")}`,
  );
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
  if (config.schedules.length > 0 && !config.admin) {
    throw new Error(
      `Profile ${profileId} with schedules must declare admin.chat_id`,
    );
  }

  const canonicalProfileDirectory = await realpath(profileDirectory);
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

  const { persona, task } = await loadPersonaAndTask(
    profileId,
    workspace,
    canonicalProfileDirectory,
  );

  return {
    id: profileId,
    directory: canonicalProfileDirectory,
    persona,
    task,
    workspace,
    runtime: config.runtime,
    model: config.model,
    ...(config.admin ? { admin: { chatId: config.admin.chat_id } } : {}),
    schedules: config.schedules.map((schedule) => ({
      id: schedule.id,
      cron: schedule.cron,
      timezone: schedule.timezone,
      input: schedule.input,
      ...(schedule.notify
        ? { notify: { chatId: schedule.notify.chat_id } }
        : {}),
    })),
  };
}

export function profileAdminChatId(profile: Profile): string {
  if (!profile.admin?.chatId) {
    throw new Error(`Profile ${profile.id} must declare admin.chat_id`);
  }
  return profile.admin.chatId;
}
