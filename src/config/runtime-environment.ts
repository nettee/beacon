import { readFile, stat } from "node:fs/promises";

const variableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const reservedVariableNames = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "GH_CONFIG_DIR",
  "NODE_OPTIONS",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "PI_OFFLINE",
  "PI_TELEMETRY",
]);

export function assertRuntimeEnvironmentKey(key: string): void {
  if (!variableNamePattern.test(key)) {
    throw new Error(`Invalid runtime environment variable name: ${key}`);
  }
  if (
    reservedVariableNames.has(key) ||
    key.startsWith("BEACON_") ||
    key.startsWith("FEISHU_")
  ) {
    throw new Error(`Runtime environment variable is reserved: ${key}`);
  }
}

function parseRuntimeEnvironment(raw: string, path: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 0) {
      throw new Error(
        `Invalid runtime environment entry at ${path}:${index + 1}: expected KEY=VALUE`,
      );
    }
    const key = line.slice(0, separator).trim();
    assertRuntimeEnvironmentKey(key);
    if (Object.hasOwn(environment, key)) {
      throw new Error(
        `Duplicate runtime environment variable at ${path}:${index + 1}: ${key}`,
      );
    }
    environment[key] = line.slice(separator + 1).trim();
  }
  return environment;
}

export async function loadRuntimeEnvironment(
  path: string,
): Promise<NodeJS.ProcessEnv> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw new Error(
      `Cannot inspect Beacon runtime environment file at ${path}`,
      {
        cause: error,
      },
    );
  }
  if (!metadata.isFile()) {
    throw new Error(`Beacon runtime environment path is not a file: ${path}`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(
      `Beacon runtime environment file must have mode 0600: ${path}`,
    );
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(
      `Beacon runtime environment file must be owned by the current user: ${path}`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read Beacon runtime environment file at ${path}`, {
      cause: error,
    });
  }
  return parseRuntimeEnvironment(raw, path);
}
