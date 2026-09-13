import assert from "node:assert/strict";
import test from "node:test";

import { parseCli } from "./cli-app.js";

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

test("rejects relative config paths and extra arguments", () => {
  assert.throws(
    () => parseCli(["serve", "--config", "config.yaml"]),
    /absolute/,
  );
  assert.throws(() => parseCli(["version", "extra"]), /Usage/);
});
