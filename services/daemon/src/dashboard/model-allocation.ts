import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DashboardModelChoice,
  ModelAllocationEntryView,
  ModelAllocationProfileView,
  ModelAllocationsResponse,
  ProfileModelPoolEntryView,
  ProfileModelView,
} from "@nettee/beacon-shared";
import { parseDocument } from "yaml";
import { z } from "zod";

import {
  getProfileDetailView,
  isProfileId,
  listProfileViews,
} from "./profiles.js";

/**
 * Fixed Dashboard whitelist — not an open model picker.
 * Keys must stay stable; labels are for UI only.
 */
export const DASHBOARD_MODEL_CHOICES: readonly DashboardModelChoice[] = [
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

export type DashboardModelKey =
  | "gpt-6-luna-high"
  | "deepseek-v4.1-flash"
  | "deepseek-flash-high"
  | "gpt-6.1-terra-high";

const choiceByKey = new Map<string, DashboardModelChoice>(
  DASHBOARD_MODEL_CHOICES.map((choice) => [choice.key, choice]),
);

function thinkingOf(model: {
  thinking?: string | undefined;
}): string | undefined {
  return model.thinking || undefined;
}

export function matchDashboardModelKey(model: {
  provider: string;
  id: string;
  thinking?: string | undefined;
}): DashboardModelKey | null {
  for (const choice of DASHBOARD_MODEL_CHOICES) {
    if (choice.provider !== model.provider || choice.id !== model.id) continue;
    if (thinkingOf(choice) === thinkingOf(model)) {
      return choice.key as DashboardModelKey;
    }
  }
  return null;
}

function choiceToModelView(choice: DashboardModelChoice): ProfileModelView {
  return {
    provider: choice.provider,
    id: choice.id,
    ...(choice.thinking ? { thinking: choice.thinking } : {}),
  };
}

function choiceToPoolEntry(
  choice: DashboardModelChoice,
  weight: number,
): ProfileModelPoolEntryView {
  return {
    ...choiceToModelView(choice),
    weight,
  };
}

function percentsFromWeights(
  weights: ReadonlyMap<DashboardModelKey, number>,
): ModelAllocationEntryView[] {
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  return DASHBOARD_MODEL_CHOICES.map((choice) => {
    const weight = weights.get(choice.key as DashboardModelKey) ?? 0;
    const percent = total > 0 ? Math.round((weight / total) * 1000) / 10 : 0;
    return {
      key: choice.key,
      label: choice.label,
      provider: choice.provider,
      id: choice.id,
      ...(choice.thinking ? { thinking: choice.thinking } : {}),
      weight,
      percent,
    };
  });
}

/** Normalize rounded percents so they sum to 100 when total weight > 0. */
function normalizePercents(
  entries: ModelAllocationEntryView[],
): ModelAllocationEntryView[] {
  const total = entries.reduce((sum, entry) => sum + entry.percent, 0);
  if (total <= 0 || Math.abs(total - 100) < 0.05) {
    return entries.map((entry) => ({
      ...entry,
      percent: total <= 0 ? 0 : Math.round(entry.percent),
    }));
  }
  // Scale then fix remainder on the largest bucket.
  const scaled = entries.map((entry) => ({
    ...entry,
    percent: Math.round((entry.percent / total) * 100),
  }));
  const sum = scaled.reduce((acc, entry) => acc + entry.percent, 0);
  if (sum !== 100 && scaled.length > 0) {
    let best = 0;
    for (let i = 1; i < scaled.length; i += 1) {
      if ((scaled[i]?.percent ?? 0) > (scaled[best]?.percent ?? 0)) best = i;
    }
    const target = scaled[best]!;
    scaled[best] = { ...target, percent: target.percent + (100 - sum) };
  }
  return scaled;
}

function allocationFromProfile(detail: {
  id: string;
  model: ProfileModelView;
  modelPool: ProfileModelPoolEntryView[] | null;
}): ModelAllocationProfileView {
  const mode =
    detail.modelPool && detail.modelPool.length > 0 ? "pool" : "single";
  const weights = new Map<DashboardModelKey, number>(
    DASHBOARD_MODEL_CHOICES.map((choice) => [
      choice.key as DashboardModelKey,
      0,
    ]),
  );

  let mapped = true;
  if (mode === "pool") {
    for (const entry of detail.modelPool ?? []) {
      const key = matchDashboardModelKey(entry);
      if (!key) {
        mapped = false;
        continue;
      }
      weights.set(key, (weights.get(key) ?? 0) + entry.weight);
    }
    if ((detail.modelPool ?? []).length === 0) mapped = false;
  } else {
    const key = matchDashboardModelKey(detail.model);
    if (!key) {
      mapped = false;
    } else {
      weights.set(key, 100);
    }
  }

  const allocations = normalizePercents(percentsFromWeights(weights));
  if (mapped) {
    // Prefer exact integers that sum to 100 for editable UI.
    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
    if (totalWeight > 0) {
      for (const entry of allocations) {
        const raw = weights.get(entry.key as DashboardModelKey) ?? 0;
        entry.weight = raw;
        entry.percent = Math.round((raw / totalWeight) * 100);
      }
      const sum = allocations.reduce((acc, entry) => acc + entry.percent, 0);
      if (sum !== 100) {
        let best = 0;
        for (let i = 1; i < allocations.length; i += 1) {
          if (allocations[i]!.percent > allocations[best]!.percent) best = i;
        }
        allocations[best] = {
          ...allocations[best]!,
          percent: allocations[best]!.percent + (100 - sum),
        };
      }
    }
  }

  return {
    profileId: detail.id,
    mode,
    mapped,
    model: detail.model,
    modelPool: detail.modelPool,
    allocations,
    error: null,
  };
}

export type ListModelAllocationsOptions = {
  /**
   * When true, serve can patch in-memory Profile model fields after PUT, so
   * list responses report `appliesOnRestart: false`.
   */
  hotReloadEnabled?: boolean | undefined;
};

export async function listModelAllocations(
  profilesDirectory: string,
  options: ListModelAllocationsOptions = {},
): Promise<ModelAllocationsResponse> {
  const list = await listProfileViews(profilesDirectory);
  const profiles: ModelAllocationProfileView[] = [];
  for (const item of list) {
    if (item.error) {
      profiles.push({
        profileId: item.id,
        mode: "single",
        mapped: false,
        model: item.model,
        modelPool: null,
        allocations: DASHBOARD_MODEL_CHOICES.map((choice) => ({
          key: choice.key,
          label: choice.label,
          provider: choice.provider,
          id: choice.id,
          ...(choice.thinking ? { thinking: choice.thinking } : {}),
          weight: 0,
          percent: 0,
        })),
        error: item.error,
      });
      continue;
    }
    const detail = await getProfileDetailView(profilesDirectory, item.id);
    if (!detail) {
      profiles.push({
        profileId: item.id,
        mode: "single",
        mapped: false,
        model: item.model,
        modelPool: null,
        allocations: DASHBOARD_MODEL_CHOICES.map((choice) => ({
          key: choice.key,
          label: choice.label,
          provider: choice.provider,
          id: choice.id,
          ...(choice.thinking ? { thinking: choice.thinking } : {}),
          weight: 0,
          percent: 0,
        })),
        error: `Unknown profile ${item.id}`,
      });
      continue;
    }
    profiles.push(allocationFromProfile(detail));
  }
  return {
    choices: DASHBOARD_MODEL_CHOICES.map((choice) => ({ ...choice })),
    profiles,
    appliesOnRestart: options.hotReloadEnabled !== true,
  };
}

const putBodySchema = z
  .object({
    percents: z.record(z.string(), z.number()),
  })
  .strict();

export class ModelAllocationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ModelAllocationError";
    this.status = status;
  }
}

export function parseModelAllocationPercents(
  body: unknown,
): Record<DashboardModelKey, number> {
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ModelAllocationError(
      400,
      "Body must be JSON { percents: { <modelKey>: number, ... } }",
    );
  }
  const { percents } = parsed.data;
  const keys = new Set(Object.keys(percents));
  for (const choice of DASHBOARD_MODEL_CHOICES) {
    if (!keys.has(choice.key)) {
      throw new ModelAllocationError(
        400,
        `Missing percent for ${choice.key} (${choice.label})`,
      );
    }
  }
  for (const key of keys) {
    if (!choiceByKey.has(key)) {
      throw new ModelAllocationError(
        400,
        `Unknown model key ${JSON.stringify(key)}; allowed: ${DASHBOARD_MODEL_CHOICES.map((c) => c.key).join(", ")}`,
      );
    }
  }

  const result = {} as Record<DashboardModelKey, number>;
  let sum = 0;
  for (const choice of DASHBOARD_MODEL_CHOICES) {
    const key = choice.key as DashboardModelKey;
    const value = percents[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new ModelAllocationError(
        400,
        `Percent for ${key} must be an integer 0–100`,
      );
    }
    result[key] = value;
    sum += value;
  }
  if (sum !== 100) {
    throw new ModelAllocationError(
      400,
      `Percents must sum to 100 (got ${String(sum)})`,
    );
  }
  return result;
}

function poolEntriesFromPercents(
  percents: Record<DashboardModelKey, number>,
): ProfileModelPoolEntryView[] {
  const entries: ProfileModelPoolEntryView[] = [];
  for (const choice of DASHBOARD_MODEL_CHOICES) {
    const percent = percents[choice.key as DashboardModelKey];
    if (percent > 0) {
      entries.push(choiceToPoolEntry(choice, percent));
    }
  }
  return entries;
}

function primaryFromPercents(
  percents: Record<DashboardModelKey, number>,
): ProfileModelView {
  let bestKey: DashboardModelKey = "gpt-6-luna-high";
  let best = -1;
  for (const choice of DASHBOARD_MODEL_CHOICES) {
    const key = choice.key as DashboardModelKey;
    const value = percents[key];
    // On ties prefer the later whitelist entry (deepseek is Mini's default primary).
    if (value >= best) {
      best = value;
      bestKey = key;
    }
  }
  return choiceToModelView(choiceByKey.get(bestKey)!);
}

async function writeProfileModelFields(
  configPath: string,
  model: ProfileModelView,
  modelPool: ProfileModelPoolEntryView[] | null,
): Promise<void> {
  const source = await readFile(configPath, "utf8");
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    throw new ModelAllocationError(
      500,
      `Invalid YAML at ${configPath}: ${document.errors[0]?.message ?? "parse error"}`,
    );
  }

  const modelNode: Record<string, string> = {
    provider: model.provider,
    id: model.id,
  };
  if (model.thinking) modelNode.thinking = model.thinking;
  document.set("model", modelNode);

  if (modelPool && modelPool.length > 0) {
    document.set(
      "model_pool",
      modelPool.map((entry) => {
        const node: Record<string, string | number> = {
          provider: entry.provider,
          id: entry.id,
          weight: entry.weight,
        };
        if (entry.thinking) node.thinking = entry.thinking;
        return node;
      }),
    );
  } else if (document.has("model_pool")) {
    document.delete("model_pool");
  }

  const temporary = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, String(document), "utf8");
  await rename(temporary, configPath);
}

export type PutModelAllocationOptions = {
  /**
   * After a successful disk write, patch the live serve Profile's
   * `model` / `modelPool`. Return true when memory was updated.
   * Absent or false → response keeps `appliesOnRestart: true`.
   */
  reloadProfileModel?: ((profileId: string) => Promise<boolean>) | undefined;
};

export async function putModelAllocation(
  profilesDirectory: string,
  profileId: string,
  body: unknown,
  options: PutModelAllocationOptions = {},
): Promise<{
  profile: ModelAllocationProfileView;
  appliesOnRestart: boolean;
}> {
  if (!isProfileId(profileId)) {
    throw new ModelAllocationError(404, "Unknown profile");
  }
  const percents = parseModelAllocationPercents(body);
  const existing = await getProfileDetailView(profilesDirectory, profileId);
  if (!existing) {
    throw new ModelAllocationError(404, `Unknown profile ${profileId}`);
  }

  const pool = poolEntriesFromPercents(percents);
  const model = primaryFromPercents(percents);
  const configPath = join(profilesDirectory, profileId, "profile.yaml");

  // 100% one model → pin `model` and clear pool (matches #88 rollback).
  await writeProfileModelFields(
    configPath,
    model,
    pool.length === 1 ? null : pool,
  );

  const detail = await getProfileDetailView(profilesDirectory, profileId);
  if (!detail) {
    throw new ModelAllocationError(
      500,
      `Profile ${profileId} missing after save`,
    );
  }

  let appliesOnRestart = true;
  if (options.reloadProfileModel) {
    try {
      appliesOnRestart = !(await options.reloadProfileModel(profileId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[beacon] model-allocation hot reload failed for profile=${profileId}: ${message}`,
      );
      appliesOnRestart = true;
    }
  }

  return {
    profile: allocationFromProfile(detail),
    appliesOnRestart,
  };
}
