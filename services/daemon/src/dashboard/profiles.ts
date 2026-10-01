import type {
  ProfileDetailView,
  ProfileListItem,
  ProfileNotifyView,
} from "@nettee/beacon-shared";

export type {
  ProfileDetailView,
  ProfileListenerView,
  ProfileListItem,
  ProfileNotifyView,
  ProfileScheduleView,
} from "@nettee/beacon-shared";

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { channelNamePattern } from "../config/channels.js";
import { parseStrictYaml } from "../config/yaml.js";

const profileIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

const adminDestinationSchema = z
  .object({ chat_id: z.string().trim().min(1) })
  .strict();

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

const scheduleSchema = z
  .object({
    id: z.string().regex(profileIdPattern),
    cron: z.string().trim().min(1),
    timezone: z.string().min(1),
    input: z.string().trim().min(1),
    notify: notifyDestinationSchema.optional(),
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
        sources: z.array(z.string().min(1)).min(1),
        types: z.array(z.string().min(1)).min(1),
        notify: notifyDestinationSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function toNotifyView(
  notify:
    | { name: string; description?: string | undefined }
    | { chat_id: string }
    | undefined,
): ProfileNotifyView | null {
  if (!notify) return null;
  if ("name" in notify) {
    return {
      kind: "channel",
      name: notify.name,
      ...(notify.description ? { description: notify.description } : {}),
    };
  }
  return { kind: "chat_id", chatId: notify.chat_id };
}

function toDetailView(
  profileId: string,
  document: z.infer<typeof profileDocumentSchema>,
): ProfileDetailView {
  return {
    id: profileId,
    workspace: document.workspace,
    runtime: document.runtime,
    model: document.model,
    admin: document.admin ? { chatId: document.admin.chat_id } : null,
    schedules: document.schedules.map((schedule) => ({
      id: schedule.id,
      cron: schedule.cron,
      timezone: schedule.timezone,
      input: schedule.input,
      notify: toNotifyView(schedule.notify),
    })),
    listener: document.listener
      ? {
          sources: document.listener.sources,
          types: document.listener.types,
          notify: toNotifyView(document.listener.notify),
        }
      : null,
    secrets: {
      present: false,
      note: "Feishu app credentials are stored in secrets.json and are not exposed by the dashboard.",
    },
  };
}

export function isProfileId(value: string): boolean {
  return profileIdPattern.test(value);
}

async function readProfileYaml(
  profilesDirectory: string,
  profileId: string,
): Promise<z.infer<typeof profileDocumentSchema>> {
  const configPath = join(profilesDirectory, profileId, "profile.yaml");
  return profileDocumentSchema.parse(await parseStrictYaml(configPath));
}

export async function listProfileViews(
  profilesDirectory: string,
): Promise<ProfileListItem[]> {
  let names: string[];
  try {
    names = await readdir(profilesDirectory);
  } catch (error) {
    throw new Error(
      `Cannot read Beacon profiles directory ${profilesDirectory}`,
      { cause: error },
    );
  }

  const ids: string[] = [];
  for (const name of names) {
    if (!isProfileId(name)) continue;
    try {
      const metadata = await stat(join(profilesDirectory, name));
      if (metadata.isDirectory()) ids.push(name);
    } catch {
      // Skip unreadable entries.
    }
  }
  ids.sort((left, right) => left.localeCompare(right));

  const items: ProfileListItem[] = [];
  for (const id of ids) {
    try {
      const document = await readProfileYaml(profilesDirectory, id);
      items.push({
        id,
        workspace: document.workspace,
        runtime: document.runtime,
        model: document.model,
        scheduleCount: document.schedules.length,
        hasAdmin: Boolean(document.admin),
        hasListener: Boolean(document.listener),
        error: null,
      });
    } catch (error) {
      items.push({
        id,
        workspace: "",
        runtime: "pi",
        model: { provider: "", id: "" },
        scheduleCount: 0,
        hasAdmin: false,
        hasListener: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return items;
}

export async function getProfileDetailView(
  profilesDirectory: string,
  profileId: string,
): Promise<ProfileDetailView | null> {
  if (!isProfileId(profileId)) return null;
  const directory = join(profilesDirectory, profileId);
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const document = await readProfileYaml(profilesDirectory, profileId);
    return toDetailView(profileId, document);
  } catch (error) {
    throw new Error(
      `Cannot load Profile ${profileId}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
