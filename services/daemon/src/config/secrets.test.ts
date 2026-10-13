import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  feishuWsListenerProfileIds,
  loadFeishuCredentials,
  resolveFeishuCredentialBindings,
} from "./secrets.js";

async function writeSecrets(
  profiles: Record<string, { app_id: string; app_secret: string }>,
  mode = 0o600,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beacon-secrets-"));
  await chmod(root, 0o700);
  const path = join(root, "secrets.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      profiles: Object.fromEntries(
        Object.entries(profiles).map(([id, feishu]) => [id, { feishu }]),
      ),
    }),
    { mode },
  );
  await chmod(path, mode);
  return path;
}

test("loads current-user 0600 Feishu credentials", async () => {
  const path = await writeSecrets({
    profile: { app_id: "cli_0123456789abcdef", app_secret: "secret" },
  });
  assert.deepEqual(await loadFeishuCredentials("profile", path), {
    appId: "cli_0123456789abcdef",
    appSecret: "secret",
  });
});

test("rejects secrets files readable by the group", async () => {
  const path = await writeSecrets(
    { profile: { app_id: "cli_0123456789abcdef", app_secret: "secret" } },
    0o640,
  );
  await assert.rejects(loadFeishuCredentials("profile", path), /0600/);
});

test("rejects a secrets parent directory accessible by group or world", async () => {
  const path = await writeSecrets({
    profile: { app_id: "cli_0123456789abcdef", app_secret: "secret" },
  });
  await chmod(dirname(path), 0o755);
  await assert.rejects(
    loadFeishuCredentials("profile", path),
    /parent directory/,
  );
});

test("rejects a malformed Feishu application id before opening a connection", async () => {
  const path = await writeSecrets({
    profile: { app_id: "not-an-app-id", app_secret: "secret" },
  });
  await assert.rejects(
    loadFeishuCredentials("profile", path),
    /Invalid Feishu app_id/,
  );
});

test("falls back to feishu.default_profile when a Profile omits secrets", async () => {
  const path = await writeSecrets({
    "beacon-triage": {
      app_id: "cli_aaaaaaaaaaaaaaaa",
      app_secret: "triage-secret",
    },
    galaxie: { app_id: "cli_bbbbbbbbbbbbbbbb", app_secret: "galaxie-secret" },
  });
  const bindings = await resolveFeishuCredentialBindings(
    ["beacon-triage", "galaxie", "temp-profile"],
    path,
    { defaultProfileId: "beacon-triage" },
  );
  assert.deepEqual(
    bindings.map((binding) => ({
      profileId: binding.profileId,
      mode: binding.mode,
      sourceProfileId: binding.sourceProfileId,
      appId: binding.credentials.appId,
    })),
    [
      {
        profileId: "beacon-triage",
        mode: "dedicated",
        sourceProfileId: "beacon-triage",
        appId: "cli_aaaaaaaaaaaaaaaa",
      },
      {
        profileId: "galaxie",
        mode: "dedicated",
        sourceProfileId: "galaxie",
        appId: "cli_bbbbbbbbbbbbbbbb",
      },
      {
        profileId: "temp-profile",
        mode: "default",
        sourceProfileId: "beacon-triage",
        appId: "cli_aaaaaaaaaaaaaaaa",
      },
    ],
  );
  assert.deepEqual([...feishuWsListenerProfileIds(bindings)].sort(), [
    "beacon-triage",
    "galaxie",
  ]);
});

test("rejects missing Profile secrets when no default_profile is configured", async () => {
  const path = await writeSecrets({
    profile: { app_id: "cli_0123456789abcdef", app_secret: "secret" },
  });
  await assert.rejects(
    resolveFeishuCredentialBindings(["profile", "missing"], path),
    /No credentials configured for profile "missing"/,
  );
});

test("rejects a default_profile that has no secrets entry", async () => {
  const path = await writeSecrets({
    profile: { app_id: "cli_0123456789abcdef", app_secret: "secret" },
  });
  await assert.rejects(
    resolveFeishuCredentialBindings(["profile"], path, {
      defaultProfileId: "beacon-triage",
    }),
    /feishu\.default_profile "beacon-triage" has no credentials/,
  );
});

test("rejects duplicate dedicated Feishu app_id across Profiles", async () => {
  const path = await writeSecrets({
    "beacon-test": {
      app_id: "cli_aaaaaaaaaaaaaaaa",
      app_secret: "shared",
    },
    "beacon-triage": {
      app_id: "cli_aaaaaaaaaaaaaaaa",
      app_secret: "shared",
    },
  });
  await assert.rejects(
    resolveFeishuCredentialBindings(["beacon-test", "beacon-triage"], path),
    /multiple Profiles \(beacon-test and beacon-triage\)/,
  );
});

test("allows the same app_id when only one Profile is dedicated", async () => {
  const path = await writeSecrets({
    "beacon-triage": {
      app_id: "cli_aaaaaaaaaaaaaaaa",
      app_secret: "shared",
    },
  });
  const bindings = await resolveFeishuCredentialBindings(
    ["beacon-triage", "temp-a", "temp-b"],
    path,
    { defaultProfileId: "beacon-triage" },
  );
  assert.equal(feishuWsListenerProfileIds(bindings).size, 1);
  assert.ok(feishuWsListenerProfileIds(bindings).has("beacon-triage"));
  assert.equal(
    bindings.filter((binding) => binding.mode === "default").length,
    2,
  );
});
