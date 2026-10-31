import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DashboardModelChoice } from "@nettee/beacon-shared";
import { z } from "zod";

import { parseStrictYaml } from "./yaml.js";

/**
 * Built-in Dashboard whitelist — used when `model-choices.yaml` is absent
 * or invalid. Keys stay stable; labels follow `provider / id [/ thinking]`.
 */
export const BUILTIN_DASHBOARD_MODEL_CHOICES: readonly DashboardModelChoice[] =
  [
    {
      key: "gpt-6-luna-high",
      label: "openai-codex / gpt-6-luna / high",
      provider: "openai-codex",
      id: "gpt-6-luna",
      thinking: "high",
    },
    {
      key: "deepseek-v4.1-flash",
      label: "opencode-go / deepseek-v4.1-flash",
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    },
    {
      key: "deepseek-flash-high",
      label: "deepseek / deepseek-flash / high",
      provider: "deepseek",
      id: "deepseek-flash",
      thinking: "high",
    },
    {
      key: "gpt-6.1-terra-high",
      label: "openai-codex / gpt-6.1-terra / high",
      provider: "openai-codex",
      id: "gpt-6.1-terra",
      thinking: "high",
    },
  ];

/** Stable key: letters/digits plus `.` `_` `-` (matches current whitelist keys). */
export const modelChoiceKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const choiceEntrySchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .regex(
        modelChoiceKeyPattern,
        "Choice key must start with a letter/digit and use only letters, digits, '.', '_' or '-'",
      ),
    /** Optional; when omitted, derived as `provider / id [/ thinking]`. */
    label: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
    thinking: z.string().trim().min(1).optional(),
  })
  .strict();

const modelChoicesDocumentSchema = z
  .object({
    version: z.literal(1),
    choices: z.array(choiceEntrySchema).min(1),
  })
  .strict();

export function formatModelChoiceLabel(choice: {
  provider: string;
  id: string;
  thinking?: string | undefined;
}): string {
  return choice.thinking
    ? `${choice.provider} / ${choice.id} / ${choice.thinking}`
    : `${choice.provider} / ${choice.id}`;
}

export function defaultModelChoicesPath(
  homeDirectory = join(homedir(), ".beacon"),
): string {
  return join(homeDirectory, "model-choices.yaml");
}

function thinkingOf(model: {
  thinking?: string | undefined;
}): string | undefined {
  return model.thinking || undefined;
}

function identityKey(choice: {
  provider: string;
  id: string;
  thinking?: string | undefined;
}): string {
  return `${choice.provider}\0${choice.id}\0${thinkingOf(choice) ?? ""}`;
}

export function normalizeModelChoices(
  entries: ReadonlyArray<{
    key: string;
    label?: string | undefined;
    provider: string;
    id: string;
    thinking?: string | undefined;
  }>,
  pathForErrors: string,
): DashboardModelChoice[] {
  const choices: DashboardModelChoice[] = [];
  const seenKeys = new Set<string>();
  const seenIdentities = new Set<string>();

  for (const entry of entries) {
    if (seenKeys.has(entry.key)) {
      throw new Error(
        `Duplicate model choice key in ${pathForErrors}: ${entry.key}`,
      );
    }
    const identity = identityKey(entry);
    if (seenIdentities.has(identity)) {
      throw new Error(
        `Duplicate model choice provider/id/thinking in ${pathForErrors}: ${formatModelChoiceLabel(entry)}`,
      );
    }
    seenKeys.add(entry.key);
    seenIdentities.add(identity);
    choices.push({
      key: entry.key,
      label: entry.label ?? formatModelChoiceLabel(entry),
      provider: entry.provider,
      id: entry.id,
      ...(entry.thinking ? { thinking: entry.thinking } : {}),
    });
  }
  return choices;
}

/**
 * Parse a model-choices document (throws on schema / duplicate errors).
 * Prefer {@link loadDashboardModelChoices} for Dashboard runtime loading.
 */
export function parseModelChoicesDocument(
  document: unknown,
  pathForErrors: string,
): DashboardModelChoice[] {
  const parsed = modelChoicesDocumentSchema.parse(document);
  return normalizeModelChoices(parsed.choices, pathForErrors);
}

export type LoadDashboardModelChoicesResult = {
  choices: readonly DashboardModelChoice[];
  /** Absolute path consulted (may be missing). */
  path: string;
  source: "file" | "builtin";
  /** Set when the file existed but was unusable and builtin fallback applied. */
  warning?: string | undefined;
};

/**
 * Load Dashboard model choices from `~/.beacon/model-choices.yaml`.
 * Missing file → builtin 4-item whitelist.
 * Invalid / unreadable file → builtin + warning (Dashboard stays available).
 */
export async function loadDashboardModelChoices(
  path = defaultModelChoicesPath(),
): Promise<LoadDashboardModelChoicesResult> {
  const metadata = await stat(path).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    const message =
      error instanceof Error ? error.message : `Cannot inspect ${path}`;
    return { error: message } as const;
  });

  if (!metadata) {
    return {
      choices: BUILTIN_DASHBOARD_MODEL_CHOICES,
      path,
      source: "builtin",
    };
  }
  if ("error" in metadata) {
    const warning = `Ignoring model-choices at ${path} (${metadata.error}); using built-in choices`;
    console.warn(`[beacon] ${warning}`);
    return {
      choices: BUILTIN_DASHBOARD_MODEL_CHOICES,
      path,
      source: "builtin",
      warning,
    };
  }
  if (!metadata.isFile()) {
    const warning = `Ignoring model-choices path ${path} (not a file); using built-in choices`;
    console.warn(`[beacon] ${warning}`);
    return {
      choices: BUILTIN_DASHBOARD_MODEL_CHOICES,
      path,
      source: "builtin",
      warning,
    };
  }

  try {
    const document = await parseStrictYaml(path);
    const choices = parseModelChoicesDocument(document, path);
    return { choices, path, source: "file" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const warning = `Ignoring invalid model-choices at ${path} (${detail}); using built-in choices`;
    console.warn(`[beacon] ${warning}`);
    return {
      choices: BUILTIN_DASHBOARD_MODEL_CHOICES,
      path,
      source: "builtin",
      warning,
    };
  }
}
