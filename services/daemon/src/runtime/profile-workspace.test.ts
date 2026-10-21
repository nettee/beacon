import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureProfileWorkspace,
  profileWorkspaceDirectory,
  workspaceSkills,
} from "./profile-workspace.js";

test("profileWorkspaceDirectory is profileDir/workspace", () => {
  assert.equal(
    profileWorkspaceDirectory("/home/u/.beacon/profiles/p"),
    "/home/u/.beacon/profiles/p/workspace",
  );
});

test("ensureProfileWorkspace creates notes/tmp and playbook/skills symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-workspace-"));
  const profileDir = join(root, "profile");
  const playbook = join(root, "playbook");
  const skillA = join(root, "agents", "skill-a");
  const skillB = join(root, "agents", "skill-b");
  await mkdir(profileDir, { recursive: true });
  await mkdir(playbook, { recursive: true });
  await mkdir(skillA, { recursive: true });
  await mkdir(skillB, { recursive: true });
  await writeFile(join(skillA, "SKILL.md"), "# A\n");
  await writeFile(join(skillB, "SKILL.md"), "# B\n");

  const ensured = await ensureProfileWorkspace({
    directory: profileDir,
    playbook,
    skills: { mode: "explicit", paths: [skillA, skillB] },
  });

  assert.equal(ensured.directory, join(profileDir, "workspace"));
  assert.equal(
    await realpath(join(ensured.directory, "playbook")),
    await realpath(playbook),
  );
  assert.equal(
    await realpath(join(ensured.directory, "skills", "skill-a")),
    await realpath(skillA),
  );
  assert.equal(
    await realpath(join(ensured.directory, "skills", "skill-b")),
    await realpath(skillB),
  );
  assert.deepEqual(ensured.skillPaths, [
    join(ensured.directory, "skills", "skill-a"),
    join(ensured.directory, "skills", "skill-b"),
  ]);

  // notes/ and tmp/ exist; repos/ is intentionally absent
  await writeFile(join(ensured.directory, "notes", "x.md"), "ok");
  await writeFile(join(ensured.directory, "tmp", "y.tmp"), "ok");
  await assert.rejects(readlink(join(ensured.directory, "repos")), /ENOENT/);

  const remapped = workspaceSkills(
    { skills: { mode: "explicit", paths: [skillA, skillB] } },
    ensured,
  );
  assert.deepEqual(remapped, { mode: "explicit", paths: ensured.skillPaths });
});

test("ensureProfileWorkspace refreshes a stale playbook symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-workspace-"));
  const profileDir = join(root, "profile");
  const playbookOld = join(root, "playbook-old");
  const playbookNew = join(root, "playbook-new");
  await mkdir(profileDir, { recursive: true });
  await mkdir(playbookOld, { recursive: true });
  await mkdir(playbookNew, { recursive: true });

  await ensureProfileWorkspace({
    directory: profileDir,
    playbook: playbookOld,
  });
  const ensured = await ensureProfileWorkspace({
    directory: profileDir,
    playbook: playbookNew,
  });
  assert.equal(
    await realpath(join(ensured.directory, "playbook")),
    await realpath(playbookNew),
  );
});
