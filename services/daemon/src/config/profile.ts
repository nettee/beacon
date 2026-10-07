import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";
import { type EventListener, eventSourceSchema } from "../events/cloudevent.js";
import { nextOccurrence } from "../schedule/cron.js";
import {
  type ChannelRegistry,
  channelNamePattern,
  defaultChannelsPath,
  emptyChannelRegistry,
  resolveChannelName,
} from "./channels.js";
import { parseStrictYaml } from "./yaml.js";

const profileIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

export const profilePersonaFile = "persona.md";
export const profileTaskFile = "task.md";
export const workspaceProfileDirectoryName = ".beacon-profile";

/** Admin DM: raw Feishu chat_id only (bot×person DMs are not channel registry entries). */
const adminDestinationSchema = z
  .object({ chat_id: z.string().trim().min(1) })
  .strict();

/** Group notify: prefer semantic name from ~/.beacon/channels.yaml; bare chat_id still loads. */
const namedDestinationSchema = z
  .object({
    name: z
      .string()
      .regex(
        channelNamePattern,
        "Channel name must be a lowercase slug (a-z, 0-9, _, -)",
      ),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

const legacyChatDestinationSchema = z
  .object({ chat_id: z.string().trim().min(1) })
  .strict();

const notifyDestinationSchema = z.union([
  namedDestinationSchema,
  legacyChatDestinationSchema,
]);

type NotifyDestinationConfig = z.infer<typeof notifyDestinationSchema>;

export type DeliveryDestination = {
  chatId: string;
  name?: string | undefined;
  description?: string | undefined;
};

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
    notify: notifyDestinationSchema.optional(),
  })
  .strict();

const skillsSchema = z
  .object({
    mode: z.literal("explicit"),
    paths: z.array(z.string().trim().min(1)).default([]),
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
    admin: adminDestinationSchema.optional(),
    schedules: z.array(scheduleSchema).default([]),
    listener: z
      .object({
        sources: z.array(eventSourceSchema).min(1),
        types: z.array(z.string().min(1)).min(1),
        notify: notifyDestinationSchema.optional(),
      })
      .strict()
      .optional(),
    /** Omit = Pi default skill discovery. `explicit` → `--no-skills` + `--skill` paths. */
    skills: skillsSchema.optional(),
  })
  .strict();

/** Resolved Profile skills. Omitted on Profile means Pi auto-discovery (today's behavior). */
export type ProfileSkills = {
  mode: "explicit";
  /** Absolute paths after ~/$HOME/workspace resolution. */
  paths: string[];
};

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
  admin?: DeliveryDestination | undefined;
  listener?: EventListener | undefined;
  schedules: Array<{
    id: string;
    cron: string;
    timezone: string;
    input: string;
    notify?: DeliveryDestination | undefined;
  }>;
  skills?: ProfileSkills | undefined;
};

export type LoadProfileOptions = {
  channels?: ChannelRegistry;
  channelsPath?: string;
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

function resolveNotifyDestination(
  destination: NotifyDestinationConfig,
  channels: ChannelRegistry,
  channelsPath: string,
): DeliveryDestination {
  if ("chat_id" in destination) {
    return { chatId: destination.chat_id };
  }
  const channel = resolveChannelName(destination.name, channels, channelsPath);
  return {
    name: channel.name,
    description: destination.description ?? channel.description,
    chatId: channel.chatId,
  };
}

/** Expand `~` / `$HOME` and resolve relative paths against the Profile workspace. */
export function resolveSkillPath(rawPath: string, workspace: string): string {
  const trimmed = rawPath.trim();
  const home = homedir();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2));
  if (trimmed === "$HOME") return home;
  if (trimmed.startsWith("$HOME/") || trimmed.startsWith("$HOME\\")) {
    return resolve(home, trimmed.slice("$HOME/".length));
  }
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(workspace, trimmed);
}

async function assertValidSkillPath(
  profileId: string,
  resolvedPath: string,
): Promise<void> {
  let pathStat: Awaited<ReturnType<typeof stat>>;
  try {
    pathStat = await stat(resolvedPath);
  } catch (error) {
    throw new Error(
      `Profile ${profileId} skill path does not exist: ${resolvedPath}`,
      { cause: error },
    );
  }
  if (pathStat.isDirectory()) {
    const skillMd = join(resolvedPath, "SKILL.md");
    if (!(await isExistingFile(skillMd))) {
      throw new Error(
        `Profile ${profileId} skill directory must contain SKILL.md: ${resolvedPath}`,
      );
    }
    return;
  }
  if (pathStat.isFile()) {
    if (!resolvedPath.endsWith(".md")) {
      throw new Error(
        `Profile ${profileId} skill file must end with .md: ${resolvedPath}`,
      );
    }
    return;
  }
  throw new Error(
    `Profile ${profileId} skill path must be a directory or .md file: ${resolvedPath}`,
  );
}

async function resolveProfileSkills(
  profileId: string,
  workspace: string,
  skills: z.infer<typeof skillsSchema>,
): Promise<ProfileSkills> {
  const paths: string[] = [];
  for (const rawPath of skills.paths) {
    const resolved = resolveSkillPath(rawPath, workspace);
    await assertValidSkillPath(profileId, resolved);
    paths.push(resolved);
  }
  return { mode: "explicit", paths };
}

export async function loadProfile(
  profileId: string,
  profilesDirectory = join(homedir(), ".beacon", "profiles"),
  options: LoadProfileOptions = {},
): Promise<Profile> {
  assertProfileId(profileId);
  const profileDirectory = join(profilesDirectory, profileId);
  const configPath = join(profileDirectory, "profile.yaml");
  const channels = options.channels ?? emptyChannelRegistry();
  const channelsPath =
    options.channelsPath ?? defaultChannelsPath(dirname(profilesDirectory));

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
    throw new Error(`Profile ${profileId} with schedules must declare admin`);
  }

  if (config.listener && !config.admin) {
    throw new Error(`Profile ${profileId} with listener must declare admin`);
  }

  const admin = config.admin ? { chatId: config.admin.chat_id } : undefined;

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

  const skills = config.skills
    ? await resolveProfileSkills(profileId, workspace, config.skills)
    : undefined;

  return {
    id: profileId,
    directory: canonicalProfileDirectory,
    persona,
    task,
    workspace,
    runtime: config.runtime,
    model: config.model,
    ...(admin ? { admin } : {}),
    ...(config.listener
      ? {
          listener: {
            sources: config.listener.sources,
            types: config.listener.types,
            ...(config.listener.notify
              ? {
                  notify: resolveNotifyDestination(
                    config.listener.notify,
                    channels,
                    channelsPath,
                  ),
                }
              : {}),
          },
        }
      : {}),
    schedules: config.schedules.map((schedule) => ({
      id: schedule.id,
      cron: schedule.cron,
      timezone: schedule.timezone,
      input: schedule.input,
      ...(schedule.notify
        ? {
            notify: resolveNotifyDestination(
              schedule.notify,
              channels,
              channelsPath,
            ),
          }
        : {}),
    })),
    ...(skills ? { skills } : {}),
  };
}

export function profileAdminChatId(profile: Profile): string {
  if (!profile.admin?.chatId) {
    throw new Error(`Profile ${profile.id} must declare admin`);
  }
  return profile.admin.chatId;
}
