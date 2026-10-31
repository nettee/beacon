export type RunRow = {
  profileId: string;
  acceptedAt: string;
  kind: string;
  scheduleId: string | null;
  kindLabel: string;
  runId: string | null;
  state: string | null;
  failureCode: string | null;
  deliveryState: string | null;
  hasSessionFile: boolean;
  feedback: Array<{ priority: "high" | "medium"; summary: string }> | null;
  observabilityFeedback: Array<{
    priority: "high" | "medium" | "low";
    summary: string;
  }> | null;
};

export type CostUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type CostBucket = CostUsageTotals & {
  runCount: number;
  runsWithUsage: number;
  runsMissingUsage: number;
};

export type CostModelRef = {
  provider: string;
  model: string;
};

export type CostModelFilter =
  | { kind: "all" }
  | { kind: "model"; model: string; provider?: string };

export type CostStatsResponse = {
  /** Fixed 7-day window for summary and charts. */
  period: "7d";
  timezone: string;
  from: string;
  to: string;
  /** Applied model filter (`all` or a provider/model pair). */
  modelFilter: CostModelFilter;
  /** Distinct provider/model pairs in the window (profile-filtered). */
  models: CostModelRef[];
  totals: CostBucket;
  byProfile: Array<CostBucket & { profileId: string }>;
  /** Same as `from`/`to` (kept for older clients). */
  chartFrom: string;
  chartTo: string;
  daily: Array<CostBucket & { date: string }>;
  /** Per calendar day × profile; same 7d window. */
  dailyByProfile: Array<CostBucket & { date: string; profileId: string }>;
};

export type ProfileListItem = {
  id: string;
  playbook: string;
  runtime: "pi";
  model: { provider: string; id: string };
  scheduleCount: number;
  hasAdmin: boolean;
  hasListener: boolean;
  error: string | null;
};

export type ProfileNotifyView =
  | { kind: "channel"; name: string; description?: string }
  | { kind: "chat_id"; chatId: string };

export type ProfileScheduleView = {
  id: string;
  cron: string;
  timezone: string;
  input: string;
  notify: ProfileNotifyView | null;
};

export type ProfileListenerView = {
  sources: string[];
  types: string[];
  notify: ProfileNotifyView | null;
};

export type ProfileSkillsView = {
  mode: "explicit";
  paths: string[];
};

export type ProfileModelView = {
  provider: string;
  id: string;
  thinking?: string | undefined;
};

export type ProfileModelPoolEntryView = ProfileModelView & {
  weight: number;
};

export type ProfileDetailView = {
  id: string;
  playbook: string;
  runtime: "pi";
  model: ProfileModelView;
  /** Present when profile.yaml declares `model_pool`; null = single model. */
  modelPool: ProfileModelPoolEntryView[] | null;
  /** Present when profile.yaml declares `max_concurrent`; null = host default. */
  maxConcurrent: number | null;
  /** Present when profile.yaml declares `max_queued`; null = host `runs.max_queued`. */
  maxQueued: number | null;
  /** Present when profile.yaml declares `timeout_seconds`; null = host `runs.timeout_seconds`. */
  timeoutSeconds: number | null;
  admin: { chatId: string } | null;
  schedules: ProfileScheduleView[];
  listener: ProfileListenerView | null;
  /** Present when profile.yaml declares `skills`; omit/null = Pi default discovery. */
  skills: ProfileSkillsView | null;
  secrets: { present: false; note: string };
};

/**
 * Dashboard whitelist entry for model allocation editing.
 * Loaded from `~/.beacon/model-choices.yaml` (built-in fallback when absent).
 * GET `/api/model-allocations` also attaches `ready` from `pi auth check`
 * (absent on the on-disk config table / built-in constants).
 */
export type DashboardModelChoice = {
  key: string;
  label: string;
  provider: string;
  id: string;
  thinking?: string | undefined;
  /**
   * Pi auth / model preflight (`pi auth check --json --no-refresh`).
   * Present on Dashboard GET responses; omitted from yaml / built-in tables.
   * When the checker is unavailable, Beacon fail-opens as `true`.
   */
  ready?: boolean | undefined;
};

export type ModelAllocationEntryView = {
  key: string;
  label: string;
  provider: string;
  id: string;
  thinking?: string | undefined;
  /** Absolute weight written to profile.yaml (same as percent when sum is 100). */
  weight: number;
  percent: number;
};

export type ModelAllocationProfileView = {
  profileId: string;
  /** `single` when no model_pool; `pool` when weighted pool is set. */
  mode: "single" | "pool";
  /** True when current model/pool only uses Dashboard whitelist models. */
  mapped: boolean;
  model: ProfileModelView;
  modelPool: ProfileModelPoolEntryView[] | null;
  /** Percents for whitelist models (sum 100 when mapped; else best-effort). */
  allocations: ModelAllocationEntryView[];
  error: string | null;
};

export type ModelAllocationsResponse = {
  choices: DashboardModelChoice[];
  profiles: ModelAllocationProfileView[];
  /**
   * When true, running `beacon serve` still needs a restart for new Runs to
   * pick up the saved ratio (no in-process reload hook). When false, serve
   * already patched the Profile `model` / `modelPool` in memory after PUT.
   * One-shot `beacon trigger` always reads the file fresh either way.
   */
  appliesOnRestart: boolean;
};

export type ModelAllocationPutRequest = {
  /** Percents for each whitelist key; must be integers 0–100 and sum to 100. */
  percents: Record<string, number>;
};

export type ModelAllocationPutResponse = {
  profile: ModelAllocationProfileView;
  appliesOnRestart: boolean;
};
