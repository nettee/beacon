import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

const feishuSecretsSchema = z
  .object({
    app_id: z.string().regex(/^cli_[0-9a-fA-F]{16}$/, "Invalid Feishu app_id"),
    app_secret: z.string().min(1),
  })
  .strict();

const secretsSchema = z
  .object({
    version: z.literal(1),
    profiles: z.record(
      z.string(),
      z
        .object({
          feishu: feishuSecretsSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type FeishuCredentials = {
  appId: string;
  appSecret: string;
};

export type FeishuCredentialBinding = {
  profileId: string;
  credentials: FeishuCredentials;
  /** Profile id whose secrets.json entry supplied the credentials. */
  sourceProfileId: string;
  /**
   * `dedicated` — this Profile has its own secrets entry (may open a WS).
   * `default` — omitted secrets; reused `feishu.default_profile` credentials
   * (outbound Delivery only; no WS).
   */
  mode: "dedicated" | "default";
};

type SecretsDocument = z.infer<typeof secretsSchema>;

async function readSecretsDocument(path: string): Promise<SecretsDocument> {
  const metadata = await stat(path).catch((error: unknown) => {
    throw new Error(`Cannot inspect Beacon secrets file at ${path}`, {
      cause: error,
    });
  });
  if (!metadata.isFile())
    throw new Error(`Beacon secrets path is not a file: ${path}`);
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Beacon secrets file must have mode 0600: ${path}`);
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(
      `Beacon secrets file must be owned by the current user: ${path}`,
    );
  }
  const parent = await stat(dirname(path));
  if ((parent.mode & 0o077) !== 0) {
    throw new Error(
      `Beacon secrets parent directory must not grant group/world access: ${dirname(path)}`,
    );
  }
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read Beacon secrets file at ${path}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Beacon secrets file is not valid JSON: ${path}`, {
      cause: error,
    });
  }

  return secretsSchema.parse(parsed);
}

function credentialsFromEntry(entry: {
  feishu: { app_id: string; app_secret: string };
}): FeishuCredentials {
  return {
    appId: entry.feishu.app_id,
    appSecret: entry.feishu.app_secret,
  };
}

/**
 * Resolve Feishu credentials for one Profile.
 * When the Profile has no secrets entry and `defaultProfileId` is set, reuse
 * that Profile's credentials (outbound-only until a dedicated app is added).
 */
export async function loadFeishuCredentialBinding(
  profileId: string,
  path = join(homedir(), ".beacon", "secrets.json"),
  options?: { defaultProfileId?: string | undefined },
): Promise<FeishuCredentialBinding> {
  const [binding] = await resolveFeishuCredentialBindings(
    [profileId],
    path,
    options,
  );
  return binding!;
}

export async function loadFeishuCredentials(
  profileId: string,
  path = join(homedir(), ".beacon", "secrets.json"),
  options?: { defaultProfileId?: string | undefined },
): Promise<FeishuCredentials> {
  const binding = await loadFeishuCredentialBinding(profileId, path, options);
  return binding.credentials;
}

/**
 * Resolve credentials for every loaded Profile, enforce one dedicated
 * secrets entry per Feishu `app_id` (no dual WS), and optionally fall back to
 * `feishu.default_profile` when a Profile omits secrets.
 */
export async function resolveFeishuCredentialBindings(
  profileIds: readonly string[],
  path = join(homedir(), ".beacon", "secrets.json"),
  options?: { defaultProfileId?: string | undefined },
): Promise<FeishuCredentialBinding[]> {
  const secrets = await readSecretsDocument(path);
  const defaultProfileId = options?.defaultProfileId;

  if (defaultProfileId !== undefined) {
    if (!secrets.profiles[defaultProfileId]) {
      throw new Error(
        `feishu.default_profile ${JSON.stringify(defaultProfileId)} has no credentials in ${path}`,
      );
    }
  }

  const bindings: FeishuCredentialBinding[] = profileIds.map((profileId) => {
    const dedicated = secrets.profiles[profileId];
    if (dedicated) {
      return {
        profileId,
        credentials: credentialsFromEntry(dedicated),
        sourceProfileId: profileId,
        mode: "dedicated" as const,
      };
    }
    if (defaultProfileId === undefined) {
      throw new Error(
        `No credentials configured for profile "${profileId}" in ${path}`,
      );
    }
    const fallback = secrets.profiles[defaultProfileId]!;
    return {
      profileId,
      credentials: credentialsFromEntry(fallback),
      sourceProfileId: defaultProfileId,
      mode: "default" as const,
    };
  });

  const dedicatedByAppId = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.mode !== "dedicated") continue;
    const previous = dedicatedByAppId.get(binding.credentials.appId);
    if (previous !== undefined) {
      throw new Error(
        `Feishu app_id ${binding.credentials.appId} is configured on multiple Profiles (${previous} and ${binding.profileId}); only one WebSocket listener is allowed per app. Give each receiving Profile its own Feishu app, or omit secrets for temporary Profiles and set feishu.default_profile.`,
      );
    }
    dedicatedByAppId.set(binding.credentials.appId, binding.profileId);
  }

  return bindings;
}

/** Profiles that open a Feishu WS (exactly the dedicated credential owners). */
export function feishuWsListenerProfileIds(
  bindings: readonly FeishuCredentialBinding[],
): Set<string> {
  return new Set(
    bindings
      .filter((binding) => binding.mode === "dedicated")
      .map((binding) => binding.profileId),
  );
}
