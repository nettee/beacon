import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeEnvironment } from "./runtime-environment.js";

async function fixture(contents: string, mode = 0o600): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beacon-runtime-environment-"));
  const path = join(root, "runtime.env");
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
  return path;
}

test("returns an empty environment when runtime.env is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-runtime-environment-"));
  assert.deepEqual(await loadRuntimeEnvironment(join(root, "runtime.env")), {});
});

test("loads literal runtime variables without shell evaluation", async () => {
  const path = await fixture(`
# Production observability
GRAFANA_READER_TOKEN_PROD=reader-token
LITERAL_COMMAND=$(touch /tmp/must-not-run)
EMPTY=
`);
  assert.deepEqual(await loadRuntimeEnvironment(path), {
    GRAFANA_READER_TOKEN_PROD: "reader-token",
    LITERAL_COMMAND: "$(touch /tmp/must-not-run)",
    EMPTY: "",
  });
});

test("requires runtime.env mode 0600", async () => {
  const path = await fixture("SAFE=value\n", 0o640);
  await assert.rejects(loadRuntimeEnvironment(path), /mode 0600/);
});

for (const [name, contents, pattern] of [
  ["malformed entries", "NOT_AN_ASSIGNMENT\n", /expected KEY=VALUE/],
  ["invalid names", "BAD-NAME=value\n", /Invalid runtime environment/],
  ["duplicate names", "DUP=one\nDUP=two\n", /Duplicate runtime environment/],
  ["Beacon capabilities", "BEACON_RUN_TOKEN=value\n", /reserved/],
  ["Feishu credentials", "FEISHU_APP_SECRET=value\n", /reserved/],
  ["Node options", "NODE_OPTIONS=value\n", /reserved/],
] as const) {
  test(`rejects ${name}`, async () => {
    const path = await fixture(contents);
    await assert.rejects(loadRuntimeEnvironment(path), pattern);
  });
}
