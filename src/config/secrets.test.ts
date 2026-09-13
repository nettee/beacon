import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadFeishuCredentials } from "./secrets.js";

async function secretsFixture(mode = 0o600): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beacon-secrets-"));
  await chmod(root, 0o700);
  const path = join(root, "secrets.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      profiles: {
        profile: { feishu: { app_id: "cli_0123456789abcdef", app_secret: "secret" } },
      },
    }),
    { mode },
  );
  await chmod(path, mode);
  return path;
}

test("loads current-user 0600 Feishu credentials", async () => {
  const path = await secretsFixture();
  assert.deepEqual(await loadFeishuCredentials("profile", path), {
    appId: "cli_0123456789abcdef",
    appSecret: "secret",
  });
});

test("rejects secrets files readable by the group", async () => {
  const path = await secretsFixture(0o640);
  await assert.rejects(loadFeishuCredentials("profile", path), /0600/);
});

test("rejects a secrets parent directory accessible by group or world", async () => {
  const path = await secretsFixture();
  await chmod(dirname(path), 0o755);
  await assert.rejects(loadFeishuCredentials("profile", path), /parent directory/);
});

test("rejects a malformed Feishu application id before opening a connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-secrets-"));
  await chmod(root, 0o700);
  const path = join(root, "secrets.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      profiles: { profile: { feishu: { app_id: "not-an-app-id", app_secret: "secret" } } },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(loadFeishuCredentials("profile", path), /Invalid Feishu app_id/);
});
