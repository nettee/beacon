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
    config.channelsPath,
    join(await realpath(root), "channels.yaml"),
  );
  assert.equal(
    config.pi.sessionDirectory,
    join(await realpath(root), "sessions"),
  );
  assert.equal(config.runs.maxConcurrent, 2);
  assert.equal(config.runs.defaultMaxConcurrent, 1);
  assert.deepEqual(config.dashboard, {
    enabled: true,
    listen: "0.0.0.0",
    port: 46183,
  });
});

test("loads an explicit dashboard bind", async () => {
  const { path } = await fixture(
    `${valid}dashboard:\n  enabled: true\n  listen: 127.0.0.1\n  port: 9001\n`,
  );
  const config = await loadGlobalConfig(path);
  assert.deepEqual(config.dashboard, {
    enabled: true,
    listen: "127.0.0.1",
    port: 9001,
  });
});

test("can disable the dashboard", async () => {
  const { path } = await fixture(`${valid}dashboard:\n  enabled: false\n`);
  const config = await loadGlobalConfig(path);
  assert.equal(config.dashboard.enabled, false);
  assert.equal(config.dashboard.listen, "0.0.0.0");
  assert.equal(config.dashboard.port, 46183);
});

test("rejects aliases and unknown fields", async () => {
  const { path } = await fixture(`${valid}\nunknown: &x 1\nalias: *x\n`);
  await assert.rejects(loadGlobalConfig(path), /alias|unrecognized/i);
});

test("loads optional default_max_concurrent under the global ceiling", async () => {
  const { path } = await fixture(
    valid.replace(
      "runs:\n  max_concurrent: 2\n  max_queued: 100\n",
      `runs:
  max_concurrent: 3
  max_queued: 100
  default_max_concurrent: 1
`,
    ),
  );
  const config = await loadGlobalConfig(path);
  assert.equal(config.runs.maxConcurrent, 3);
  assert.equal(config.runs.defaultMaxConcurrent, 1);
});

test("loads optional runs.on_failure_profile", async () => {
  const { path } = await fixture(
    valid.replace(
      "  terminate_grace_seconds: 5\n",
      "  terminate_grace_seconds: 5\n  on_failure_profile: beacon-triage\n",
    ),
  );
  const config = await loadGlobalConfig(path);
  assert.equal(config.runs.onFailureProfile, "beacon-triage");
});

test("rejects invalid runs.on_failure_profile ids", async () => {
  const { path } = await fixture(
    valid.replace(
      "  terminate_grace_seconds: 5\n",
      "  terminate_grace_seconds: 5\n  on_failure_profile: Bad Profile\n",
    ),
  );
  await assert.rejects(loadGlobalConfig(path), /on_failure_profile/i);
});

test("rejects runs.profiles (per-profile limits belong on Profile yaml)", async () => {
  const { path } = await fixture(
    valid.replace(
      "runs:\n  max_concurrent: 2\n  max_queued: 100\n",
      `runs:
  max_concurrent: 3
  max_queued: 100
  profiles:
    alert-diagnoser:
      max_concurrent: 2
`,
    ),
  );
  await assert.rejects(loadGlobalConfig(path), /unrecognized/i);
});

test("rejects default_max_concurrent above the global ceiling", async () => {
  const { path } = await fixture(
    valid.replace(
      "  max_concurrent: 2\n  max_queued: 100\n",
      "  max_concurrent: 2\n  max_queued: 100\n  default_max_concurrent: 4\n",
    ),
  );
  await assert.rejects(loadGlobalConfig(path), /global ceiling/i);
});

test("discovers profiles in deterministic order", async () => {
  const { root, path } = await fixture(valid);
  for (const id of ["zeta", "alpha"]) {
    const directory = join(root, "profiles", id);
    await mkdir(directory);
    await writeFile(join(directory, "persona.md"), id);
    await writeFile(join(directory, "task.md"), `${id} task`);
    await writeFile(
      join(directory, "profile.yaml"),
      `playbook: .\nruntime: pi\nmodel:\n  provider: test\n  id: model\n`,
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

test("events are opt-in with private defaults and a home-relative credentials path", async () => {
  const disabled = await fixture(`${valid}events:\n  enabled: false\n`);
  assert.equal((await loadGlobalConfig(disabled.path)).events, undefined);
  const { path, root } = await fixture(
    `${valid}events:\n  enabled: true\n  credentials_file: event-credentials.json\n`,
  );
  assert.deepEqual((await loadGlobalConfig(path)).events, {
    listen: "127.0.0.1",
    port: 46184,
    maxBodyBytes: 262144,
    maxPending: 1000,
    credentialsPath: join(await realpath(root), "event-credentials.json"),
  });
});

test("enabled events require credentials and valid limits", async () => {
  for (const options of [
    "enabled: true",
    "enabled: true\n  credentials_file: creds.json\n  max_pending: 0",
    "enabled: true\n  credentials_file: creds.json\n  port: 65536",
    "enabled: true\n  credentials_file: creds.json\n  max_body_bytes: -1",
  ]) {
    const { path } = await fixture(`${valid}events:\n  ${options}\n`);
    await assert.rejects(loadGlobalConfig(path));
  }
});
