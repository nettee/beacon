import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProfile } from "./profile.js";

const baseYaml = `
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
`;

async function profileFixture(
  yaml = baseYaml,
  options?: {
    persona?: string | null;
    task?: string | null;
  },
): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "beacon-profiles-"));
  const directory = join(root, "test-profile");
  await mkdir(directory);
  await writeFile(join(directory, "profile.yaml"), yaml);
  if (options?.persona !== null) {
    await writeFile(
      join(directory, "persona.md"),
      options?.persona ?? "You are Beacon.",
    );
  }
  if (options?.task !== null) {
    await writeFile(
      join(directory, "task.md"),
      options?.task ?? "Follow the workspace SOP.",
    );
  }
  return { root, directory };
}

test("loads persona.md and task.md from the Profile directory", async () => {
  const { root } = await profileFixture(baseYaml, {
    persona: "You are Beacon.",
    task: "Run the daily check.",
  });

  const profile = await loadProfile("test-profile", root);
  assert.equal(profile.id, "test-profile");
  assert.equal(profile.persona, "You are Beacon.");
  assert.equal(profile.task, "Run the daily check.");
  assert.equal(profile.runtime, "pi");
  assert.deepEqual(profile.model, { provider: "openrouter", id: "test/model" });
  assert.deepEqual(profile.schedules, []);
});

test("loads a strict scheduled notify chat", async () => {
  const { root } = await profileFixture(`
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
  const { root } = await profileFixture(`
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
  const { root } = await profileFixture(`
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

test("rejects yaml prompt and other unknown Profile fields", async () => {
  const { root } = await profileFixture(`
prompt: prompt.md
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
`);

  await assert.rejects(loadProfile("test-profile", root), /unrecognized_keys/);
});

test("rejects a leftover prompt.md fallback when persona.md is missing", async () => {
  const { root, directory } = await profileFixture(baseYaml, {
    persona: null,
  });
  await writeFile(join(directory, "prompt.md"), "legacy whole prompt");

  await assert.rejects(
    loadProfile("test-profile", root),
    /Cannot read Profile persona\.md/,
  );
});

test("rejects a missing task.md", async () => {
  const { root } = await profileFixture(baseYaml, { task: null });

  await assert.rejects(
    loadProfile("test-profile", root),
    /Cannot read Profile task\.md/,
  );
});

test("rejects an empty persona.md", async () => {
  const { root } = await profileFixture(baseYaml, { persona: "   \n" });

  await assert.rejects(
    loadProfile("test-profile", root),
    /persona\.md must not be empty/,
  );
});

test("rejects a persona.md symlink outside its Profile directory", async () => {
  const { root, directory } = await profileFixture(baseYaml, { persona: null });
  await writeFile(join(root, "outside.md"), "outside");
  await symlink(join(root, "outside.md"), join(directory, "persona.md"));

  await assert.rejects(loadProfile("test-profile", root), /must stay inside/);
});

test("rejects unsupported runtimes", async () => {
  const { root } = await profileFixture(`
workspace: .
runtime: sdk
model:
  provider: openrouter
  id: test/model
`);

  await assert.rejects(loadProfile("test-profile", root), /Invalid input/);
});

test("rejects invalid five-field cron during Profile loading", async () => {
  const { root } = await profileFixture(`
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
