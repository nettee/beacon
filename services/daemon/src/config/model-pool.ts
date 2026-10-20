/** Pi `--thinking` levels (see `pi --help`). */
export const piThinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof piThinkingLevels)[number];

/** One concrete model choice for a Run (provider + id + optional thinking). */
export type ProfileModelChoice = {
  provider: string;
  id: string;
  thinking?: PiThinkingLevel | undefined;
};

/** Weighted pool entry from profile.yaml `model_pool`. */
export type ProfileModelPoolEntry = ProfileModelChoice & {
  weight: number;
};

export type SelectProfileModelOptions = {
  /** Injected RNG in [0, 1). Defaults to `Math.random`. */
  random?: (() => number) | undefined;
};

/**
 * Pick the model for one Run.
 *
 * - No `modelPool` → always `model` (today's behavior).
 * - With `modelPool` → weighted random over pool entries (weights must be > 0).
 */
export function selectProfileModel(
  profile: {
    model: ProfileModelChoice;
    modelPool?: readonly ProfileModelPoolEntry[] | undefined;
  },
  options: SelectProfileModelOptions = {},
): ProfileModelChoice {
  const pool = profile.modelPool;
  if (!pool || pool.length === 0) {
    return {
      provider: profile.model.provider,
      id: profile.model.id,
      ...(profile.model.thinking ? { thinking: profile.model.thinking } : {}),
    };
  }

  const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) {
    throw new Error("model_pool weights must sum to a positive finite number");
  }

  const random = options.random ?? Math.random;
  let sample = random();
  if (!(sample >= 0) || !(sample < 1) || !Number.isFinite(sample)) {
    throw new Error("model_pool random() must return a number in [0, 1)");
  }
  sample *= totalWeight;

  let cumulative = 0;
  for (const entry of pool) {
    cumulative += entry.weight;
    if (sample < cumulative) {
      return {
        provider: entry.provider,
        id: entry.id,
        ...(entry.thinking ? { thinking: entry.thinking } : {}),
      };
    }
  }

  // Floating-point edge: sample == totalWeight after multiply is impossible with
  // sample in [0,1), but guard the last entry anyway.
  const last = pool[pool.length - 1]!;
  return {
    provider: last.provider,
    id: last.id,
    ...(last.thinking ? { thinking: last.thinking } : {}),
  };
}
