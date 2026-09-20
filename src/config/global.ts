import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { parseStrictYaml } from "./yaml.js";

const positiveInteger = z.number().int().positive().safe();

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
    runs: z
      .object({
        max_concurrent: positiveInteger,
        max_queued: z.number().int().nonnegative().safe(),
        timeout_seconds: positiveInteger,
        terminate_grace_seconds: positiveInteger,
      })
      .strict(),
    scheduler: z
      .object({ max_occurrences_per_reconciliation: positiveInteger })
      .strict(),
  })
  .strict();

export type GlobalConfig = {
  path: string;
  homeDirectory: string;
  profilesDirectory: string;
  secretsPath: string;
  runtimeEnvironmentPath: string;
  pi: {
    executable: string;
    codingAgentDirectory: string;
    sessionDirectory: string;
  };
  runs: {
    maxConcurrent: number;
    maxQueued: number;
    timeoutSeconds: number;
    terminateGraceSeconds: number;
  };
  scheduler: { maxOccurrencesPerReconciliation: number };
};

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
      timeoutSeconds: document.runs.timeout_seconds,
      terminateGraceSeconds: document.runs.terminate_grace_seconds,
    },
    scheduler: {
      maxOccurrencesPerReconciliation:
        document.scheduler.max_occurrences_per_reconciliation,
    },
  };
}
