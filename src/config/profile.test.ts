import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProfile } from "./profile.js";

async function profileFixture(
  yaml: string,
  prompt = "You are Beacon.",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beacon-profiles-"));
  const directory = join(root, "test-profile");
  await mkdir(directory);
  await writeFile(join(directory, "profile.yaml"), yaml);
  await writeFile(join(directory, "prompt.md"), prompt);
  return root;
}

test("loads one directory-isolated Profile and its Markdown prompt", async () => {
  const root = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
`);

  const profile = await loadProfile("test-profile", root);
  assert.equal(profile.id, "test-profile");
  assert.equal(profile.prompt, "You are Beacon.");
  assert.equal(profile.runtime, "pi");
  assert.deepEqual(profile.model, { provider: "openrouter", id: "test/model" });
  assert.deepEqual(profile.schedules, []);
});

test("loads a strict scheduled notify chat", async () => {
  const root = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
admin:
  chat_id: oc_admin
schedules:
  - id: daily-intel
    cron: "0 9 * * *"
    timezone: Asia/Shanghai
    input: Build the report.
    notify:
      chat_id: oc_chat
`);

  const profile = await loadProfile("test-profile", root);
  assert.deepEqual(profile.admin, { chatId: "oc_admin" });
  assert.deepEqual(profile.schedules, [
    {
      id: "daily-intel",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      input: "Build the report.",
      notify: { chatId: "oc_chat" },
    },
  ]);
});

test("rejects schedules without admin.chat_id", async () => {
  const root = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
schedules:
  - id: daily-intel
    cron: "0 9 * * *"
    timezone: Asia/Shanghai
    input: Build the report.
`);

  await assert.rejects(
    loadProfile("test-profile", root),
    /must declare admin.chat_id/,
  );
});

test("rejects the deferred access field", async () => {
  const root = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
access:
  mode: allow_all
`);

  await assert.rejects(loadProfile("test-profile", root), /unrecognized_keys/);
});

test("rejects unknown Profile fields", async () => {
  const root = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
unexpected: true
`);

  await assert.rejects(loadProfile("test-profile", root), /unrecognized_keys/);
});

test("rejects a prompt outside its Profile directory", async () => {
  const root = await profileFixture(`
prompt: ../outside.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
`);
  await writeFile(join(root, "outside.md"), "outside");

  await assert.rejects(loadProfile("test-profile", root), /must stay inside/);
});

test("rejects unsupported runtimes", async () => {
  const root = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: sdk
model:
  provider: openrouter
  id: test/model
`);

  await assert.rejects(loadProfile("test-profile", root), /Invalid input/);
});

test("rejects invalid five-field cron during Profile loading", async () => {
  const root = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
admin:
  chat_id: oc_admin
schedules:
  - id: broken
    cron: "99 99 * * *"
    timezone: UTC
    input: report
    notify:
      chat_id: oc_chat
`);

  await assert.rejects(
    loadProfile("test-profile", root),
    /Invalid Schedule cron/,
  );
});
