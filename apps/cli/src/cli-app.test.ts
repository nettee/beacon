import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultConfigPath, parseCli } from "./cli-app.js";

test("parses the public CLI commands", () => {
  assert.deepEqual(parseCli(["serve", "--config", "/tmp/config.yaml"]), {
    command: "serve",
    config: "/tmp/config.yaml",
  });
  assert.deepEqual(
    parseCli([
      "trigger",
      "--config",
      "/tmp/config.yaml",
      "--profile",
      "model-intel",
      "--input",
      "-",
    ]),
    { command: "trigger", config: "/tmp/config.yaml", profile: "model-intel" },
  );
  assert.deepEqual(parseCli(["version"]), { command: "version" });
});

test("uses the running user's default config for service and operator commands", () => {
  assert.equal(defaultConfigPath, join(homedir(), ".beacon", "config.yaml"));
  assert.deepEqual(parseCli(["serve"]), {
    command: "serve",
    config: defaultConfigPath,
  });
  assert.deepEqual(parseCli(["doctor"]), {
    command: "doctor",
    config: defaultConfigPath,
  });
  assert.deepEqual(
    parseCli(["trigger", "--profile", "model-intel", "--input", "-"]),
    { command: "trigger", config: defaultConfigPath, profile: "model-intel" },
  );
  assert.deepEqual(
    parseCli([
      "schedule",
      "trigger",
      "--profile",
      "model-intel",
      "--schedule",
      "daily",
    ]),
    {
      command: "schedule-trigger",
      config: defaultConfigPath,
      profile: "model-intel",
      schedule: "daily",
    },
  );
});

test("validates config options consistently for all config commands", () => {
  for (const args of [
    ["serve"],
    ["doctor"],
    ["trigger", "--profile", "example", "--input", "-"],
    ["schedule", "trigger", "--profile", "example", "--schedule", "daily"],
  ]) {
    assert.equal(
      (
        parseCli([...args, "--config", "/opt/beacon/config.yaml"]) as {
          config: string;
        }
      ).config,
      "/opt/beacon/config.yaml",
    );
    for (const config of ["config.yaml", "~/.beacon/config.yaml"]) {
      assert.throws(() => parseCli([...args, "--config", config]), /absolute/);
    }
    for (const extra of [
      ["--config"],
      ["--config", ""],
      ["--config", "/tmp/a", "--config", "/tmp/b"],
      ["--unknown", "value"],
      ["extra"],
    ]) {
      assert.throws(() => parseCli([...args, ...extra]), /Usage/);
    }
  }
});

test("usage documents the optional service config and shared default", () => {
  assert.throws(
    () => parseCli([]),
    /beacon serve \[--config <absolute-path>\][\s\S]*Config defaults to ~\/\.beacon\/config.yaml/,
  );
});

test("serve resolves the user's home outside cwd and fails visibly without fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "beacon-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await mkdir(join(home, ".beacon"), { recursive: true });
  await mkdir(cwd);
  // A cwd config must never substitute for the selected home config.
  await writeFile(join(cwd, "config.yaml"), "version: 999\n");
  const configPath = join(home, ".beacon", "config.yaml");
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const tsxPath = import.meta.resolve("tsx");
  const run = (args: string[], expected: string | RegExp): void => {
    const result = spawnSync(
      process.execPath,
      ["--import", tsxPath, cliPath, ...args],
      {
        cwd,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\[beacon\] fatal:/);
    if (typeof expected === "string")
      assert.ok(result.stderr.includes(expected), result.stderr);
    else assert.match(result.stderr, expected);
  };

  run(["serve"], `Required file does not exist: ${configPath}`);
  await writeFile(configPath, "version: [\n");
  run(["serve"], /YAML|flow sequence/i);
  await writeFile(configPath, "version: 999\n");
  run(["serve"], /Invalid input/);

  const missingPi = join(root, "missing-pi");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      profiles_directory: cwd,
      pi: { executable: missingPi, coding_agent_directory: cwd },
      runs: {
        max_concurrent: 1,
        max_queued: 1,
        timeout_seconds: 10,
        terminate_grace_seconds: 1,
      },
      scheduler: { max_occurrences_per_reconciliation: 1 },
    }),
  );
  run(["serve"], `Required file does not exist: ${missingPi}`);
  const override = join(root, "override.yaml");
  run(
    ["serve", "--config", override],
    `Required file does not exist: ${override}`,
  );
  await writeFile(override, "version: 999\n");
  run(["serve", "--config", override], /Invalid input/);
});

test("allows an absolute config override for a Schedule Trigger", () => {
  assert.deepEqual(
    parseCli([
      "schedule",
      "trigger",
      "--schedule",
      "daily",
      "--config",
      "/opt/beacon/config.yaml",
      "--profile",
      "model-intel",
    ]),
    {
      command: "schedule-trigger",
      config: "/opt/beacon/config.yaml",
      profile: "model-intel",
      schedule: "daily",
    },
  );
});

test("rejects relative config paths and extra arguments", () => {
  assert.throws(
    () => parseCli(["serve", "--config", "config.yaml"]),
    /absolute/,
  );
  assert.throws(
    () =>
      parseCli([
        "schedule",
        "trigger",
        "--config",
        "config.yaml",
        "--profile",
        "profile",
        "--schedule",
        "daily",
      ]),
    /absolute/,
  );
  assert.throws(
    () =>
      parseCli([
        "schedule",
        "trigger",
        "--profile",
        "profile",
        "--schedule",
        "daily",
        "--extra",
        "value",
      ]),
    /Usage/,
  );
  assert.throws(() => parseCli(["version", "extra"]), /Usage/);
});
