import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { parseStrictYaml } from "./yaml.js";

export const channelNamePattern = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

const channelEntrySchema = z
  .object({
    name: z
      .string()
      .regex(
        channelNamePattern,
        "Channel name must be a lowercase slug (a-z, 0-9, _, -)",
      ),
    description: z.string().trim().min(1),
    chat_id: z.string().trim().min(1),
  })
  .strict();

const channelsDocumentSchema = z
  .object({
    version: z.literal(1),
    channels: z.array(channelEntrySchema).default([]),
  })
  .strict();

export type Channel = {
  name: string;
  description: string;
  chatId: string;
};

export type ChannelRegistry = ReadonlyMap<string, Channel>;

export function defaultChannelsPath(
  homeDirectory = join(homedir(), ".beacon"),
): string {
  return join(homeDirectory, "channels.yaml");
}

export function emptyChannelRegistry(): ChannelRegistry {
  return new Map();
}

export async function loadChannelRegistry(
  path: string,
): Promise<ChannelRegistry> {
  const metadata = await stat(path).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new Error(`Cannot inspect Beacon channels file at ${path}`, {
      cause: error,
    });
  });
  if (!metadata) return emptyChannelRegistry();
  if (!metadata.isFile()) {
    throw new Error(`Beacon channels path is not a file: ${path}`);
  }

  const document = channelsDocumentSchema.parse(await parseStrictYaml(path));
  const registry = new Map<string, Channel>();
  for (const entry of document.channels) {
    if (registry.has(entry.name)) {
      throw new Error(`Duplicate channel name in ${path}: ${entry.name}`);
    }
    registry.set(entry.name, {
      name: entry.name,
      description: entry.description,
      chatId: entry.chat_id,
    });
  }
  return registry;
}

export function resolveChannelName(
  name: string,
  channels: ChannelRegistry,
  channelsPath: string,
): Channel {
  const channel = channels.get(name);
  if (!channel) {
    throw new Error(
      `Unknown Feishu channel name ${JSON.stringify(name)}; define it in ${channelsPath}`,
    );
  }
  return channel;
}
