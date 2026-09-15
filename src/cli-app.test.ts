import assert from "node:assert/strict";
import test from "node:test";

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

test("uses the default config for operator commands", () => {
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
