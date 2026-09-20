import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadGlobalConfig } from "./global.js";
import { loadProfileRegistry } from "./registry.js";

async function fixture(
  config: string,
): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "beacon-global-"));
  const profiles = join(root, "profiles");
  const piHome = join(root, "pi-home");
  const pi = join(root, "pi");
  await mkdir(profiles);
  await mkdir(piHome);
  await writeFile(pi, "#!/bin/sh\n", { mode: 0o700 });
  await chmod(pi, 0o700);
  const path = join(root, "config.yaml");
  await writeFile(path, config.replaceAll("$ROOT", root));
  return { root, path };
}

const valid = `
version: 1
profiles_directory: profiles
pi:
  executable: $ROOT/pi
  coding_agent_directory: $ROOT/pi-home
runs:
  max_concurrent: 2
  max_queued: 100
  timeout_seconds: 1800
  terminate_grace_seconds: 5
scheduler:
  max_occurrences_per_reconciliation: 1000
`;

test("loads strict global configuration with resolved paths", async () => {
  const { root, path } = await fixture(valid);
  const config = await loadGlobalConfig(path);
  assert.equal(
    config.profilesDirectory,
    await realpath(join(root, "profiles")),
  );
  assert.equal(config.pi.executable, await realpath(join(root, "pi")));
  assert.equal(
    config.runtimeEnvironmentPath,
    join(await realpath(root), "runtime.env"),
  );
  assert.equal(
    config.pi.sessionDirectory,
    join(await realpath(root), "sessions"),
  );
  assert.equal(config.runs.maxConcurrent, 2);
});

test("rejects aliases and unknown fields", async () => {
  const { path } = await fixture(`${valid}\nunknown: &x 1\nalias: *x\n`);
  await assert.rejects(loadGlobalConfig(path), /alias|unrecognized/i);
});

test("discovers profiles in deterministic order", async () => {
  const { root, path } = await fixture(valid);
  for (const id of ["zeta", "alpha"]) {
    const directory = join(root, "profiles", id);
    await mkdir(directory);
    await writeFile(join(directory, "prompt.md"), id);
    await writeFile(
      join(directory, "profile.yaml"),
      `prompt: prompt.md\nworkspace: .\nruntime: pi\nmodel:\n  provider: test\n  id: model\n`,
    );
  }
  const config = await loadGlobalConfig(path);
  const profiles = await loadProfileRegistry(config.profilesDirectory);
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["alpha", "zeta"],
  );
});

test("rejects relative Pi runtime paths", async () => {
  const { path } = await fixture(valid.replace("$ROOT/pi", "pi"));
  await assert.rejects(
    loadGlobalConfig(path),
    /executable path must be absolute/,
  );
});

test("accepts an explicit absolute Pi session directory", async () => {
  const { root, path } = await fixture(
    valid.replace(
      "  coding_agent_directory: $ROOT/pi-home",
      "  coding_agent_directory: $ROOT/pi-home\n  session_directory: $ROOT/pi-sessions",
    ),
  );
  const config = await loadGlobalConfig(path);
  assert.equal(config.pi.sessionDirectory, join(root, "pi-sessions"));
});

test("rejects a relative Pi session directory", async () => {
  const { path } = await fixture(
    valid.replace(
      "  coding_agent_directory: $ROOT/pi-home",
      "  coding_agent_directory: $ROOT/pi-home\n  session_directory: sessions",
    ),
  );
  await assert.rejects(
    loadGlobalConfig(path),
    /session directory path must be absolute/,
  );
});
