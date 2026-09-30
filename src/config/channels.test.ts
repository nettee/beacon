import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadChannelRegistry, resolveChannelName } from "./channels.js";

async function writeChannels(
  channels: string,
): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "beacon-channels-"));
  const path = join(root, "channels.yaml");
  await writeFile(path, channels);
  return { root, path };
}

test("loads an empty registry when channels.yaml is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-channels-missing-"));
  const registry = await loadChannelRegistry(join(root, "channels.yaml"));
  assert.equal(registry.size, 0);
});

test("loads named Feishu group channels", async () => {
  const { path } = await writeChannels(`
version: 1
channels:
  - name: amr-development-group
    description: AMR 项目开发群
    chat_id: oc_amr_dev
  - name: release-impact
    description: AMR 发布影响报告群
    chat_id: oc_release_group
`);
  const registry = await loadChannelRegistry(path);
  assert.deepEqual(
    [...registry.keys()],
    ["amr-development-group", "release-impact"],
  );
  assert.deepEqual(registry.get("amr-development-group"), {
    name: "amr-development-group",
    description: "AMR 项目开发群",
    chatId: "oc_amr_dev",
  });
});

test("rejects duplicate channel names", async () => {
  const { path } = await writeChannels(`
version: 1
channels:
  - name: admin
    description: one
    chat_id: oc_a
  - name: admin
    description: two
    chat_id: oc_b
`);
  await assert.rejects(loadChannelRegistry(path), /Duplicate channel name/);
});

test("rejects invalid channel names", async () => {
  const { path } = await writeChannels(`
version: 1
channels:
  - name: Bad Name
    description: invalid
    chat_id: oc_a
`);
  await assert.rejects(loadChannelRegistry(path), /Channel name/);
});

test("resolves a known channel and fails on unknown names", async () => {
  const { path } = await writeChannels(`
version: 1
channels:
  - name: admin
    description: Admin DM
    chat_id: oc_admin
`);
  const registry = await loadChannelRegistry(path);
  assert.equal(resolveChannelName("admin", registry, path).chatId, "oc_admin");
  assert.throws(
    () => resolveChannelName("missing", registry, path),
    /Unknown Feishu channel name "missing"/,
  );
});

test("rejects unknown fields and wrong versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-channels-strict-"));
  await mkdir(root, { recursive: true });
  const path = join(root, "channels.yaml");
  await writeFile(
    path,
    "version: 2\nchannels:\n  - name: a\n    description: d\n    chat_id: oc\n",
  );
  await assert.rejects(loadChannelRegistry(path), /Invalid input|Literal/);
});
