import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadChannelRegistry } from "./channels.js";
import {
  loadProfile,
  resolveSkillPath,
  workspaceProfileDirectory,
} from "./profile.js";

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
    workspacePersona?: string | null;
    workspaceTask?: string | null;
  },
): Promise<{ root: string; directory: string; workspace: string }> {
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
  const workspaceDir = workspaceProfileDirectory(directory);
  if (options?.workspacePersona != null || options?.workspaceTask != null) {
    await mkdir(workspaceDir);
  }
  if (options?.workspacePersona != null) {
    await writeFile(join(workspaceDir, "persona.md"), options.workspacePersona);
  }
  if (options?.workspaceTask != null) {
    await writeFile(join(workspaceDir, "task.md"), options.workspaceTask);
  }
  return { root, directory, workspace: directory };
}

test("example Profile loads persona.md and task.md from examples/workspace/.beacon-profile", async () => {
  const profiles = fileURLToPath(
    new URL("../../../../examples/profiles", import.meta.url),
  );
  const channelsPath = fileURLToPath(
    new URL("../../../../examples/channels.yaml.example", import.meta.url),
  );
  const channels = await loadChannelRegistry(channelsPath);
  const profile = await loadProfile("example", profiles, {
    channels,
    channelsPath,
  });
  assert.match(profile.persona, /workspace-status assistant/);
  assert.match(profile.task, /inspect the configured workspace/);
  assert.equal(
    profile.workspace,
    fileURLToPath(new URL("../../../../examples/workspace", import.meta.url)),
  );
  assert.deepEqual(profile.admin, {
    chatId: "REPLACE_WITH_ADMIN_DIRECT_CHAT_ID",
  });
  assert.deepEqual(profile.schedules[0]?.notify, {
    name: "weekday-brief-group",
    description: "Example weekday brief notify group",
    chatId: "REPLACE_WITH_GROUP_CHAT_ID",
  });
});

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

test("loads persona.md and task.md from the configured workspace .beacon-profile", async () => {
  const { root, directory } = await profileFixture(
    `
workspace: ../workspace
runtime: pi
model:
  provider: openrouter
  id: test/model
`,
    {
      persona: null,
      task: null,
    },
  );
  const workspace = join(root, "workspace");
  const workspaceDir = workspaceProfileDirectory(workspace);
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "persona.md"), "Workspace persona.");
  await writeFile(join(workspaceDir, "task.md"), "Workspace task.");
  const decoy = workspaceProfileDirectory(directory);
  await mkdir(decoy);
  await writeFile(join(decoy, "persona.md"), "Decoy persona.");
  await writeFile(join(decoy, "task.md"), "Decoy task.");

  const profile = await loadProfile("test-profile", root);
  assert.equal(profile.persona, "Workspace persona.");
  assert.equal(profile.task, "Workspace task.");
  assert.equal(profile.workspace, workspace);
});

test("prefers the workspace pair when both pairs exist", async () => {
  const { root } = await profileFixture(baseYaml, {
    persona: "Profile-dir persona.",
    task: "Profile-dir task.",
    workspacePersona: "Workspace persona.",
    workspaceTask: "Workspace task.",
  });

  const profile = await loadProfile("test-profile", root);
  assert.equal(profile.persona, "Workspace persona.");
  assert.equal(profile.task, "Workspace task.");
});

test("does not mix a workspace file with a Profile-directory file", async () => {
  const { root, directory } = await profileFixture(baseYaml, {
    persona: null,
    task: "Profile-dir task.",
    workspacePersona: "Workspace persona.",
  });

  await assert.rejects(loadProfile("test-profile", root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /no complete persona\.md \+ task\.md pair/);
    assert.ok(
      error.message.includes(
        join(workspaceProfileDirectory(directory), "task.md"),
      ),
    );
    assert.ok(error.message.includes(join(directory, "persona.md")));
    assert.equal(error.message.includes("Workspace persona."), false);
    return true;
  });
});

test("uses the Profile-directory pair when the workspace pair is incomplete", async () => {
  const { root } = await profileFixture(baseYaml, {
    persona: "Profile-dir persona.",
    task: "Profile-dir task.",
    workspacePersona: "Workspace persona only.",
  });

  const profile = await loadProfile("test-profile", root);
  assert.equal(profile.persona, "Profile-dir persona.");
  assert.equal(profile.task, "Profile-dir task.");
});

test("lists missing paths when neither pair is complete", async () => {
  const { root, directory } = await profileFixture(baseYaml, {
    persona: null,
    task: null,
  });

  await assert.rejects(loadProfile("test-profile", root), (error: unknown) => {
    assert.ok(error instanceof Error);
    const workspaceDir = workspaceProfileDirectory(directory);
    assert.match(error.message, /no complete persona\.md \+ task\.md pair/);
    assert.ok(error.message.includes(join(workspaceDir, "persona.md")));
    assert.ok(error.message.includes(join(workspaceDir, "task.md")));
    assert.ok(error.message.includes(join(directory, "persona.md")));
    assert.ok(error.message.includes(join(directory, "task.md")));
    return true;
  });
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

test("resolves notify destinations by channel name; admin uses chat_id", async () => {
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
      name: reports
      description: Override description
`);
  const channelsPath = join(root, "channels.yaml");
  await writeFile(
    channelsPath,
    `
version: 1
channels:
  - name: reports
    description: Reports group
    chat_id: oc_group
`,
  );
  const channels = await loadChannelRegistry(channelsPath);
  const profile = await loadProfile("test-profile", root, {
    channels,
    channelsPath,
  });
  assert.deepEqual(profile.admin, { chatId: "oc_admin" });
  assert.deepEqual(profile.schedules[0]?.notify, {
    name: "reports",
    description: "Override description",
    chatId: "oc_group",
  });
});

test("rejects admin.name — admin must use chat_id, not a channel", async () => {
  const { root } = await profileFixture(`
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
admin:
  name: admin-dm
schedules:
  - id: daily-intel
    cron: "0 9 * * *"
    timezone: Asia/Shanghai
    input: Build the report.
`);
  await assert.rejects(
    loadProfile("test-profile", root),
    /Invalid input|chat_id/,
  );
});

test("rejects unknown notify channel names at Profile load", async () => {
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
      name: missing-channel
`);
  const channelsPath = join(root, "channels.yaml");
  await writeFile(channelsPath, "version: 1\nchannels: []\n");
  await assert.rejects(
    loadProfile("test-profile", root, {
      channels: await loadChannelRegistry(channelsPath),
      channelsPath,
    }),
    /Unknown Feishu channel name "missing-channel"/,
  );
});

test("rejects schedules without admin", async () => {
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

  await assert.rejects(loadProfile("test-profile", root), /must declare admin/);
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

test("rejects yaml persona and task path fields", async () => {
  const { root } = await profileFixture(`
workspace: .
runtime: pi
model:
  provider: openrouter
  id: test/model
persona: persona.md
task: task.md
`);

  await assert.rejects(loadProfile("test-profile", root), /unrecognized_keys/);
});

test("rejects a leftover prompt.md fallback when persona.md is missing", async () => {
  const { root, directory } = await profileFixture(baseYaml, {
    persona: null,
  });
  await writeFile(join(directory, "prompt.md"), "legacy whole prompt");

  await assert.rejects(loadProfile("test-profile", root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /no complete persona\.md \+ task\.md pair/);
    assert.match(error.message, /persona\.md/);
    assert.doesNotMatch(error.message, /legacy whole prompt/);
    return true;
  });
});

test("ignores leftover prompt.md in workspace .beacon-profile", async () => {
  const { root, directory } = await profileFixture(baseYaml, {
    persona: "Profile-dir persona.",
    task: "Profile-dir task.",
  });
  const workspaceDir = workspaceProfileDirectory(directory);
  await mkdir(workspaceDir);
  await writeFile(join(workspaceDir, "prompt.md"), "workspace legacy prompt");

  const profile = await loadProfile("test-profile", root);
  assert.equal(profile.persona, "Profile-dir persona.");
  assert.equal(profile.task, "Profile-dir task.");
});

test("rejects a missing task.md", async () => {
  const { root, directory } = await profileFixture(baseYaml, { task: null });

  await assert.rejects(loadProfile("test-profile", root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /no complete persona\.md \+ task\.md pair/);
    assert.ok(error.message.includes(join(directory, "task.md")));
    return true;
  });
});

test("rejects an empty persona.md", async () => {
  const { root } = await profileFixture(baseYaml, { persona: "   \n" });

  await assert.rejects(
    loadProfile("test-profile", root),
    /persona\.md must not be empty/,
  );
});

test("rejects an empty workspace persona.md without falling back", async () => {
  const { root } = await profileFixture(baseYaml, {
    persona: "Profile-dir persona.",
    task: "Profile-dir task.",
    workspacePersona: "   \n",
    workspaceTask: "Workspace task.",
  });

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

test("rejects a workspace persona.md symlink outside the workspace", async () => {
  const { root, directory } = await profileFixture(baseYaml, {
    persona: null,
    task: null,
  });
  await writeFile(join(root, "outside.md"), "outside");
  const workspaceDir = workspaceProfileDirectory(directory);
  await mkdir(workspaceDir);
  await symlink(join(root, "outside.md"), join(workspaceDir, "persona.md"));
  await writeFile(join(workspaceDir, "task.md"), "Workspace task.");

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

test("loads exact event listener with normalized notification target", async () => {
  const { root } = await profileFixture(
    `${baseYaml}admin:\n  chat_id: admin\nlistener:\n  sources: [/production]\n  types: [deployment.completed.v1]\n  notify:\n    chat_id: reports\n`,
  );
  assert.deepEqual((await loadProfile("test-profile", root)).listener, {
    sources: ["/production"],
    types: ["deployment.completed.v1"],
    notify: { chatId: "reports" },
  });
});

test("listener requires explicit sources, types and admin chat", async () => {
  for (const listener of [
    "sources: []\n  types: [deployed]",
    "sources: [/prod]\n  types: []",
    "sources: [/prod]",
    "sources: [bad source]\n  types: [deployed]",
  ]) {
    const { root } = await profileFixture(
      `${baseYaml}admin:\n  chat_id: admin\nlistener:\n  ${listener}\n`,
    );
    await assert.rejects(loadProfile("test-profile", root));
  }
  const { root } = await profileFixture(
    `${baseYaml}listener:\n  sources: [/prod]\n  types: [deployed]\n`,
  );
  await assert.rejects(
    loadProfile("test-profile", root),
    /listener must declare admin/,
  );
});

test("resolveSkillPath expands ~ and $HOME against workspace", () => {
  const home = homedir();
  assert.equal(
    resolveSkillPath("~/.agents/skills/tea-cli", "/ws"),
    join(home, ".agents/skills/tea-cli"),
  );
  assert.equal(
    resolveSkillPath("$HOME/.agents/skills/tea-cli", "/ws"),
    join(home, ".agents/skills/tea-cli"),
  );
  assert.equal(
    resolveSkillPath("skills/local", "/ws"),
    join("/ws", "skills/local"),
  );
  assert.equal(resolveSkillPath("/abs/skill", "/ws"), "/abs/skill");
});

test("omitted skills keeps Profile.skills undefined (Pi auto discovery)", async () => {
  const { root } = await profileFixture(baseYaml);
  const profile = await loadProfile("test-profile", root);
  assert.equal(profile.skills, undefined);
});

test("explicit skills resolves ~ and relative paths and validates SKILL.md", async () => {
  const { root, directory } = await profileFixture(baseYaml);
  const skillDir = join(directory, "skills", "tea-cli");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# tea-cli\n");
  const mdSkill = join(directory, "skills", "extra.md");
  await writeFile(mdSkill, "# extra\n");

  await writeFile(
    join(directory, "profile.yaml"),
    `${baseYaml}skills:\n  mode: explicit\n  paths:\n    - skills/tea-cli\n    - ./skills/extra.md\n`,
  );

  const profile = await loadProfile("test-profile", root);
  assert.deepEqual(profile.skills, {
    mode: "explicit",
    paths: [skillDir, mdSkill],
  });
});

test("explicit skills with empty paths is allowed", async () => {
  const { root } = await profileFixture(
    `${baseYaml}skills:\n  mode: explicit\n  paths: []\n`,
  );
  const profile = await loadProfile("test-profile", root);
  assert.deepEqual(profile.skills, { mode: "explicit", paths: [] });
});

test("explicit skills fail-fast when path is missing or lacks SKILL.md", async () => {
  const { root, directory } = await profileFixture(
    `${baseYaml}skills:\n  mode: explicit\n  paths:\n    - skills/missing\n`,
  );
  await assert.rejects(
    loadProfile("test-profile", root),
    /skill path does not exist/,
  );

  const emptyDir = join(directory, "skills", "empty");
  await mkdir(emptyDir, { recursive: true });
  await writeFile(
    join(directory, "profile.yaml"),
    `${baseYaml}skills:\n  mode: explicit\n  paths:\n    - skills/empty\n`,
  );
  await assert.rejects(
    loadProfile("test-profile", root),
    /must contain SKILL.md/,
  );
});
