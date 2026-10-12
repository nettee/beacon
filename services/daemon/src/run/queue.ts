export type QueueSubmission =
  | { accepted: false }
  | { accepted: true; completion: Promise<void> };

export type ProfileRunLimits = {
  maxConcurrent: number;
  maxQueued?: number | undefined;
};

export type RunQueueOptions = {
  /** Global ceiling on simultaneously active runs across all profiles. */
  maxConcurrent: number;
  /** Default per-profile queue depth when a profile does not override max_queued. */
  maxQueued: number;
  /**
   * Default per-profile concurrency when Profile yaml omits `max_concurrent`.
   * Defaults to 1.
   */
  defaultMaxConcurrent?: number | undefined;
  /** Per-profile limits from Profile yaml, keyed by Profile ID. */
  profiles?: Readonly<Record<string, ProfileRunLimits>> | undefined;
};

export type ProfileRunLimitSource = {
  id: string;
  maxConcurrent?: number | undefined;
  maxQueued?: number | undefined;
};

export type RunAdmissionDefaults = {
  maxConcurrent: number;
  maxQueued: number;
  defaultMaxConcurrent: number;
};

/**
 * Build per-profile queue limits from loaded Profiles and reject any Profile
 * whose effective concurrency exceeds the host-wide ceiling.
 */
export function profileLimitsFromProfiles(
  profiles: readonly ProfileRunLimitSource[],
  defaults: Pick<
    RunAdmissionDefaults,
    "maxConcurrent" | "defaultMaxConcurrent"
  >,
): Record<string, ProfileRunLimits> {
  const limits: Record<string, ProfileRunLimits> = {};
  for (const profile of profiles) {
    const maxConcurrent =
      profile.maxConcurrent ?? defaults.defaultMaxConcurrent;
    if (maxConcurrent > defaults.maxConcurrent) {
      throw new Error(
        `Profile ${profile.id} max_concurrent (${String(maxConcurrent)}) exceeds runs.max_concurrent (${String(defaults.maxConcurrent)})`,
      );
    }
    if (
      profile.maxConcurrent !== undefined ||
      profile.maxQueued !== undefined
    ) {
      limits[profile.id] = {
        maxConcurrent,
        ...(profile.maxQueued !== undefined
          ? { maxQueued: profile.maxQueued }
          : {}),
      };
    }
  }
  return limits;
}

/** Construct a RunQueue from global runs defaults + loaded Profiles. */
export function createRunQueue(
  defaults: RunAdmissionDefaults,
  profiles: readonly ProfileRunLimitSource[],
): RunQueue {
  return new RunQueue({
    maxConcurrent: defaults.maxConcurrent,
    maxQueued: defaults.maxQueued,
    defaultMaxConcurrent: defaults.defaultMaxConcurrent,
    profiles: profileLimitsFromProfiles(profiles, defaults),
  });
}

type Pending = {
  profileId: string;
  task: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type ProfileLane = {
  active: number;
  /** Count of this profile's entries currently in `pending` (not yet active). */
  queued: number;
  waiting: Pending[];
};

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

/**
 * Multi-lane Run admission: each Profile has its own concurrency and queue
 * budget so one Profile cannot exhaust another's slots. `maxConcurrent` is a
 * host-wide ceiling across all active Runs.
 */
export class RunQueue {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly defaultMaxConcurrent: number;
  private readonly profileLimits: Readonly<Record<string, ProfileRunLimits>>;
  private globalActive = 0;
  private readonly pending: Pending[] = [];
  private readonly lanes = new Map<string, ProfileLane>();

  constructor(options: RunQueueOptions) {
    assertPositiveInteger("maxConcurrent", options.maxConcurrent);
    assertNonNegativeInteger("maxQueued", options.maxQueued);
    const defaultMaxConcurrent = options.defaultMaxConcurrent ?? 1;
    assertPositiveInteger("defaultMaxConcurrent", defaultMaxConcurrent);
    if (defaultMaxConcurrent > options.maxConcurrent) {
      throw new Error(
        "defaultMaxConcurrent must be <= maxConcurrent (global ceiling)",
      );
    }
    for (const [profileId, limits] of Object.entries(options.profiles ?? {})) {
      assertPositiveInteger(
        `profiles.${profileId}.maxConcurrent`,
        limits.maxConcurrent,
      );
      if (limits.maxConcurrent > options.maxConcurrent) {
        throw new Error(
          `profiles.${profileId}.maxConcurrent must be <= maxConcurrent (global ceiling)`,
        );
      }
      if (limits.maxQueued !== undefined) {
        assertNonNegativeInteger(
          `profiles.${profileId}.maxQueued`,
          limits.maxQueued,
        );
      }
    }
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueued = options.maxQueued;
    this.defaultMaxConcurrent = defaultMaxConcurrent;
    this.profileLimits = options.profiles ?? {};
  }

  limitsFor(profileId: string): { maxConcurrent: number; maxQueued: number } {
    const override = this.profileLimits[profileId];
    return {
      maxConcurrent: override?.maxConcurrent ?? this.defaultMaxConcurrent,
      maxQueued: override?.maxQueued ?? this.maxQueued,
    };
  }

  enqueue(profileId: string, task: () => Promise<void>): QueueSubmission {
    const limits = this.limitsFor(profileId);
    const lane = this.lane(profileId);
    if (
      lane.active >= limits.maxConcurrent &&
      lane.queued >= limits.maxQueued
    ) {
      return { accepted: false };
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pending.push({ profileId, task, resolve, reject });
    lane.queued += 1;
    this.drain();
    return { accepted: true, completion };
  }

  /** Wait for admission without dropping already accepted, persisted event work. */
  enqueueWhenAvailable(
    profileId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.lane(profileId).waiting.push({
        profileId,
        task,
        resolve,
        reject,
      });
    });
    this.drain();
    return completion;
  }

  private lane(profileId: string): ProfileLane {
    let lane = this.lanes.get(profileId);
    if (!lane) {
      lane = { active: 0, queued: 0, waiting: [] };
      this.lanes.set(profileId, lane);
    }
    return lane;
  }

  private promoteWaiting(profileId: string): void {
    const limits = this.limitsFor(profileId);
    const lane = this.lane(profileId);
    while (
      lane.waiting.length > 0 &&
      lane.queued <
        limits.maxQueued + Math.max(0, limits.maxConcurrent - lane.active)
    ) {
      const next = lane.waiting.shift()!;
      this.pending.push(next);
      lane.queued += 1;
    }
  }

  private promoteAllWaiting(): void {
    for (const profileId of this.lanes.keys()) {
      this.promoteWaiting(profileId);
    }
  }

  private async execute(next: Pending): Promise<void> {
    const lane = this.lane(next.profileId);
    try {
      await next.task();
      next.resolve();
    } catch (error) {
      next.reject(error);
    } finally {
      lane.active -= 1;
      this.globalActive -= 1;
      this.drain();
    }
  }

  private drain(): void {
    this.promoteAllWaiting();
    while (this.globalActive < this.maxConcurrent) {
      const index = this.pending.findIndex((entry) => {
        const limits = this.limitsFor(entry.profileId);
        return this.lane(entry.profileId).active < limits.maxConcurrent;
      });
      if (index < 0) return;
      const next = this.pending.splice(index, 1)[0]!;
      const lane = this.lane(next.profileId);
      lane.queued -= 1;
      lane.active += 1;
      this.globalActive += 1;
      this.promoteWaiting(next.profileId);
      void this.execute(next);
    }
  }
}
