import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  BUILTIN_DASHBOARD_MODEL_CHOICES,
  defaultModelChoicesPath,
  loadDashboardModelChoices,
} from "../config/model-choices.js";
import {
  authIdentityKey,
  type PiAuthCheckResult,
  type PiAuthCheckTarget,
  probeChoiceAuthReady,
} from "../runtime/pi-auth-check.js";
import {
  getProfileDetailView,
  isProfileId,
  listProfileViews,
} from "./profiles.js";

/**
 * Built-in fallback whitelist (no `model-choices.yaml`).
 * Prefer {@link loadDashboardModelChoices} / runtime `choices` for live tables.
 */
export const DASHBOARD_MODEL_CHOICES: readonly DashboardModelChoice[] =
  BUILTIN_DASHBOARD_MODEL_CHOICES;

/** Stable choice key from the configured (or built-in) whitelist. */
export type DashboardModelKey = string;

function choiceMap(
  choices: readonly DashboardModelChoice[],
): Map<string, DashboardModelChoice> {
  return new Map(choices.map((choice) => [choice.key, choice]));
}

function thinkingOf(model: {
  thinking?: string | undefined;
}): string | undefined {
  return model.thinking || undefined;
}

export function matchDashboardModelKey(
  model: {
    provider: string;
    id: string;
    thinking?: string | undefined;
  },
  choices: readonly DashboardModelChoice[] = DASHBOARD_MODEL_CHOICES,
): DashboardModelKey | null {
  for (const choice of choices) {
    if (choice.provider !== model.provider || choice.id !== model.id) continue;
    if (thinkingOf(choice) === thinkingOf(model)) {
      return choice.key;
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
  choices: readonly DashboardModelChoice[],
): ModelAllocationEntryView[] {
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  return choices.map((choice) => {
    const weight = weights.get(choice.key) ?? 0;
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

function emptyAllocations(
  choices: readonly DashboardModelChoice[],
): ModelAllocationEntryView[] {
  return choices.map((choice) => ({
    key: choice.key,
    label: choice.label,
    provider: choice.provider,
    id: choice.id,
    ...(choice.thinking ? { thinking: choice.thinking } : {}),
    weight: 0,
    percent: 0,
  }));
}

function allocationFromProfile(
  detail: {
    id: string;
    model: ProfileModelView;
    modelPool: ProfileModelPoolEntryView[] | null;
  },
  choices: readonly DashboardModelChoice[],
): ModelAllocationProfileView {
  const mode =
    detail.modelPool && detail.modelPool.length > 0 ? "pool" : "single";
  const weights = new Map<DashboardModelKey, number>(
    choices.map((choice) => [choice.key, 0]),
  );

  let mapped = true;
  if (mode === "pool") {
    for (const entry of detail.modelPool ?? []) {
      const key = matchDashboardModelKey(entry, choices);
      if (!key) {
        mapped = false;
        continue;
      }
      weights.set(key, (weights.get(key) ?? 0) + entry.weight);
    }
    if ((detail.modelPool ?? []).length === 0) mapped = false;
  } else {
    const key = matchDashboardModelKey(detail.model, choices);
    if (!key) {
      mapped = false;
    } else {
      weights.set(key, 100);
    }
  }

  const allocations = normalizePercents(percentsFromWeights(weights, choices));
  if (mapped) {
    // Prefer exact integers that sum to 100 for editable UI.
    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
    if (totalWeight > 0) {
      for (const entry of allocations) {
        const raw = weights.get(entry.key) ?? 0;
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

export type ModelAuthChecker = (
  target: PiAuthCheckTarget,
) => Promise<PiAuthCheckResult>;

export type ListModelAllocationsOptions = {
  /**
   * When true, serve can patch in-memory Profile model fields after PUT, so
   * list responses report `appliesOnRestart: false`.
   */
  hotReloadEnabled?: boolean | undefined;
  /** Override loaded choices (tests). */
  choices?: readonly DashboardModelChoice[] | undefined;
  /** Override `~/.beacon/model-choices.yaml` path. */
  modelChoicesPath?: string | undefined;
  /**
   * Optional `pi auth check` probe. When set, each choice gets `ready`.
   * Inconclusive probes fail open as `ready: true`.
   */
  checkAuthReady?: ModelAuthChecker | undefined;
};

function displayReady(result: PiAuthCheckResult | undefined): boolean {
  // Fail open when the checker is missing or inconclusive (old Pi / spawn error).
  if (!result?.conclusive) return true;
  return result.ready;
}

async function annotateChoicesReady(
  choices: readonly DashboardModelChoice[],
  checkAuthReady: ModelAuthChecker | undefined,
): Promise<DashboardModelChoice[]> {
  if (!checkAuthReady) {
    return choices.map((choice) => ({ ...choice, ready: true }));
  }
  const probes = await probeChoiceAuthReady(choices, checkAuthReady);
  return choices.map((choice) => ({
    ...choice,
    ready: displayReady(probes.get(authIdentityKey(choice))),
  }));
}

function assertReadyPercents(
  percents: Record<DashboardModelKey, number>,
  choices: readonly DashboardModelChoice[],
  probes: ReadonlyMap<string, PiAuthCheckResult>,
): void {
  const blocked: string[] = [];
  for (const choice of choices) {
    const percent = percents[choice.key] ?? 0;
    if (percent <= 0) continue;
    const result = probes.get(authIdentityKey(choice));
    if (!result?.conclusive) continue;
    if (result.ready) continue;
    const detail = result.reason ? ` (${result.reason})` : "";
    blocked.push(`${choice.key} [${choice.label}]${detail}`);
  }
  if (blocked.length > 0) {
    throw new ModelAllocationError(
      400,
      `Model(s) not ready via pi auth check: ${blocked.join("; ")}. Set dashboard.reject_unready_models: false to allow, or fix Pi auth.`,
    );
  }
}

async function resolveChoices(
  profilesDirectory: string,
  options: {
    choices?: readonly DashboardModelChoice[] | undefined;
    modelChoicesPath?: string | undefined;
  },
): Promise<readonly DashboardModelChoice[]> {
  if (options.choices) return options.choices;
  const path =
    options.modelChoicesPath ??
    defaultModelChoicesPath(dirname(profilesDirectory));
  return (await loadDashboardModelChoices(path)).choices;
}

export async function listModelAllocations(
  profilesDirectory: string,
  options: ListModelAllocationsOptions = {},
): Promise<ModelAllocationsResponse> {
  const choices = await resolveChoices(profilesDirectory, options);
  const annotated = await annotateChoicesReady(choices, options.checkAuthReady);
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
        allocations: emptyAllocations(choices),
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
        allocations: emptyAllocations(choices),
        error: `Unknown profile ${item.id}`,
      });
      continue;
    }
    profiles.push(allocationFromProfile(detail, choices));
  }
  return {
    choices: annotated,
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
  choices: readonly DashboardModelChoice[] = DASHBOARD_MODEL_CHOICES,
): Record<DashboardModelKey, number> {
  if (choices.length === 0) {
    throw new ModelAllocationError(
      500,
      "No Dashboard model choices configured",
    );
  }
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ModelAllocationError(
      400,
      "Body must be JSON { percents: { <modelKey>: number, ... } }",
    );
  }
  const { percents } = parsed.data;
  const keys = new Set(Object.keys(percents));
  const byKey = choiceMap(choices);
  for (const choice of choices) {
    if (!keys.has(choice.key)) {
      throw new ModelAllocationError(
        400,
        `Missing percent for ${choice.key} (${choice.label})`,
      );
    }
  }
  for (const key of keys) {
    if (!byKey.has(key)) {
      throw new ModelAllocationError(
        400,
        `Unknown model key ${JSON.stringify(key)}; allowed: ${choices.map((c) => c.key).join(", ")}`,
      );
    }
  }

  const result: Record<DashboardModelKey, number> = {};
  let sum = 0;
  for (const choice of choices) {
    const key = choice.key;
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
  choices: readonly DashboardModelChoice[],
): ProfileModelPoolEntryView[] {
  const byKey = choiceMap(choices);
  const entries: ProfileModelPoolEntryView[] = [];
  for (const choice of choices) {
    const percent = percents[choice.key] ?? 0;
    if (percent > 0) {
      entries.push(choiceToPoolEntry(byKey.get(choice.key)!, percent));
    }
  }
  return entries;
}

function primaryFromPercents(
  percents: Record<DashboardModelKey, number>,
  choices: readonly DashboardModelChoice[],
): ProfileModelView {
  const byKey = choiceMap(choices);
  let bestKey: DashboardModelKey = choices[0]!.key;
  let best = -1;
  for (const choice of choices) {
    const key = choice.key;
    const value = percents[key] ?? 0;
    // On ties prefer the later whitelist entry (deepseek is Mini's default primary).
    if (value >= best) {
      best = value;
      bestKey = key;
    }
  }
  return choiceToModelView(byKey.get(bestKey)!);
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
  /** Override loaded choices (tests). */
  choices?: readonly DashboardModelChoice[] | undefined;
  /** Override `~/.beacon/model-choices.yaml` path. */
  modelChoicesPath?: string | undefined;
  /**
   * Optional `pi auth check` probe. Used when `rejectUnreadyModels` is true
   * (default) to refuse percents > 0 for conclusively not-ready choices.
   */
  checkAuthReady?: ModelAuthChecker | undefined;
  /**
   * When true (default) and a checker is provided, reject allocating weight to
   * choices that conclusively fail `pi auth check`. Inconclusive probes do not
   * block. Set false via `dashboard.reject_unready_models`.
   */
  rejectUnreadyModels?: boolean | undefined;
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
  const choices = await resolveChoices(profilesDirectory, options);
  const percents = parseModelAllocationPercents(body, choices);
  const existing = await getProfileDetailView(profilesDirectory, profileId);
  if (!existing) {
    throw new ModelAllocationError(404, `Unknown profile ${profileId}`);
  }

  const rejectUnready = options.rejectUnreadyModels !== false;
  if (rejectUnready && options.checkAuthReady) {
    const selected = choices.filter(
      (choice) => (percents[choice.key] ?? 0) > 0,
    );
    const probes = await probeChoiceAuthReady(selected, options.checkAuthReady);
    assertReadyPercents(percents, choices, probes);
  }

  const pool = poolEntriesFromPercents(percents, choices);
  const model = primaryFromPercents(percents, choices);
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
    profile: allocationFromProfile(detail, choices),
    appliesOnRestart,
  };
}
