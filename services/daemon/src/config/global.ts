import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { parseStrictYaml } from "./yaml.js";

const positiveInteger = z.number().int().positive().safe();
const nonNegativeInteger = z.number().int().nonnegative().safe();
const profileIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

const runsDocumentSchema = z
  .object({
    /** Host-wide ceiling on simultaneously active Runs across all Profiles. */
    max_concurrent: positiveInteger,
    /**
     * Default per-Profile queue depth. Each Profile has its own queue so one
     * Profile cannot exhaust another's capacity. Override on Profile yaml with
     * `max_queued`.
     */
    max_queued: nonNegativeInteger,
    /**
     * Default per-Profile concurrency when Profile yaml omits `max_concurrent`.
     * Defaults to 1.
     */
    default_max_concurrent: positiveInteger.optional(),
    timeout_seconds: positiveInteger,
    terminate_grace_seconds: positiveInteger,
    /**
     * When set, every other Profile's failed Run enqueues one Trigger on this
     * Profile (same moment as Feishu failure notify). Deduped by
     * `sourceKey=["on_failure", failedProfileId, failedRunId]`.
     */
    on_failure_profile: z
      .string()
      .regex(profileIdPattern, "runs.on_failure_profile must be a Profile id")
      .optional(),
  })
  .strict()
  .superRefine((runs, context) => {
    const defaultMax = runs.default_max_concurrent ?? 1;
    if (defaultMax > runs.max_concurrent) {
      context.addIssue({
        code: "custom",
        message:
          "runs.default_max_concurrent must be <= runs.max_concurrent (global ceiling)",
        path: ["default_max_concurrent"],
      });
    }
  });

const globalDocumentSchema = z
  .object({
    version: z.literal(1),
    profiles_directory: z.string().min(1),
    pi: z
      .object({
        executable: z.string().min(1),
        coding_agent_directory: z.string().min(1),
        session_directory: z.string().min(1).optional(),
      })
      .strict(),
    runs: runsDocumentSchema,
    scheduler: z
      .object({ max_occurrences_per_reconciliation: positiveInteger })
      .strict(),
    events: z
      .object({
        enabled: z.boolean().default(false),
        listen: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(46184),
        max_body_bytes: positiveInteger.default(262144),
        max_pending: positiveInteger.default(1000),
        credentials_file: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (value) => !value.enabled || value.credentials_file !== undefined,
        "events.credentials_file is required when events are enabled",
      )
      .optional(),
    dashboard: z
      .object({
        enabled: z.boolean().optional(),
        listen: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).safe().optional(),
      })
      .strict()
      .optional(),
    /**
     * Optional Feishu defaults. Profiles that omit secrets.json entries reuse
     * `default_profile`'s app for outbound Delivery only (one WS per app).
     */
    feishu: z
      .object({
        default_profile: z
          .string()
          .regex(
            profileIdPattern,
            "feishu.default_profile must be a Profile id",
          ),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GlobalConfig = {
  path: string;
  homeDirectory: string;
  profilesDirectory: string;
  secretsPath: string;
  channelsPath: string;
  runtimeEnvironmentPath: string;
  pi: {
    executable: string;
    codingAgentDirectory: string;
    sessionDirectory: string;
  };
  runs: {
    /** Host-wide ceiling on simultaneously active Runs across all Profiles. */
    maxConcurrent: number;
    /** Default per-Profile queue depth (each Profile has an isolated queue). */
    maxQueued: number;
    /** Default per-Profile concurrency when Profile yaml omits `max_concurrent`. */
    defaultMaxConcurrent: number;
    timeoutSeconds: number;
    terminateGraceSeconds: number;
    /** Optional Profile that receives an `on_failure` Trigger for each failed Run. */
    onFailureProfile?: string | undefined;
  };
  scheduler: { maxOccurrencesPerReconciliation: number };
  events?: {
    listen: string;
    port: number;
    maxBodyBytes: number;
    maxPending: number;
    credentialsPath: string;
  };
  dashboard: {
    enabled: boolean;
    listen: string;
    port: number;
  };
  /**
   * When set, Profiles without a dedicated secrets.json entry reuse this
   * Profile's Feishu app for outbound Delivery (no extra WebSocket).
   */
  feishu?: {
    defaultProfile: string;
  };
};

export const defaultDashboard = {
  enabled: true,
  listen: "0.0.0.0",
  port: 46183,
} as const;

async function assertFile(path: string, executable = false): Promise<string> {
  const canonical = await realpath(path).catch((error: unknown) => {
    throw new Error(`Required file does not exist: ${path}`, { cause: error });
  });
  const metadata = await stat(canonical);
  if (!metadata.isFile())
    throw new Error(`Required path is not a file: ${path}`);
  if (executable) await access(canonical, constants.X_OK);
  return canonical;
}

async function assertDirectory(path: string): Promise<string> {
  const canonical = await realpath(path).catch((error: unknown) => {
    throw new Error(`Required directory does not exist: ${path}`, {
      cause: error,
    });
  });
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Required path is not a directory: ${path}`);
  }
  return canonical;
}

export async function loadGlobalConfig(path: string): Promise<GlobalConfig> {
  if (!isAbsolute(path))
    throw new Error(`Global config path must be absolute: ${path}`);
  const canonicalPath = await assertFile(path);
  const document = globalDocumentSchema.parse(
    await parseStrictYaml(canonicalPath),
  );
  const homeDirectory = dirname(canonicalPath);
  const resolveFromHome = (value: string): string =>
    isAbsolute(value) ? value : resolve(homeDirectory, value);

  const profilesDirectory = await assertDirectory(
    resolveFromHome(document.profiles_directory),
  );
  if (!isAbsolute(document.pi.executable)) {
    throw new Error("Pi executable path must be absolute");
  }
  if (!isAbsolute(document.pi.coding_agent_directory)) {
    throw new Error("Pi coding agent directory must be absolute");
  }
  if (
    document.pi.session_directory !== undefined &&
    !isAbsolute(document.pi.session_directory)
  ) {
    throw new Error("Pi session directory path must be absolute");
  }
  const executable = await assertFile(document.pi.executable, true);
  const codingAgentDirectory = await assertDirectory(
    document.pi.coding_agent_directory,
  );

  return {
    path: canonicalPath,
    homeDirectory,
    profilesDirectory,
    secretsPath: resolve(homeDirectory, "secrets.json"),
    channelsPath: resolve(homeDirectory, "channels.yaml"),
    runtimeEnvironmentPath: resolve(homeDirectory, "runtime.env"),
    pi: {
      executable,
      codingAgentDirectory,
      // Keep version 1 configurations valid while moving sessions out of Pi's
      // workspace-derived default hierarchy.
      sessionDirectory:
        document.pi.session_directory ?? join(homeDirectory, "sessions"),
    },
    runs: {
      maxConcurrent: document.runs.max_concurrent,
      maxQueued: document.runs.max_queued,
      defaultMaxConcurrent: document.runs.default_max_concurrent ?? 1,
      timeoutSeconds: document.runs.timeout_seconds,
      terminateGraceSeconds: document.runs.terminate_grace_seconds,
      ...(document.runs.on_failure_profile
        ? { onFailureProfile: document.runs.on_failure_profile }
        : {}),
    },
    scheduler: {
      maxOccurrencesPerReconciliation:
        document.scheduler.max_occurrences_per_reconciliation,
    },
    ...(document.events?.enabled
      ? {
          events: {
            listen: document.events.listen,
            port: document.events.port,
            maxBodyBytes: document.events.max_body_bytes,
            maxPending: document.events.max_pending,
            credentialsPath: resolveFromHome(document.events.credentials_file!),
          },
        }
      : {}),
    dashboard: {
      enabled: document.dashboard?.enabled ?? defaultDashboard.enabled,
      listen: document.dashboard?.listen ?? defaultDashboard.listen,
      port: document.dashboard?.port ?? defaultDashboard.port,
    },
    ...(document.feishu
      ? { feishu: { defaultProfile: document.feishu.default_profile } }
      : {}),
  };
}
