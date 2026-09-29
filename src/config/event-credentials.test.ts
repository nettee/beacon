import assert from "node:assert/strict";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEventCredentials } from "./event-credentials.js";

const producer = {
  id: "deploy",
  token: "a".repeat(32),
  sources: ["/production"],
};
async function fixture(value: unknown = { version: 1, producers: [producer] }) {
  const root = await mkdtemp(join(tmpdir(), "beacon-event-credentials-"));
  await chmod(root, 0o700);
  const path = join(root, "credentials.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { root, path };
}

test("loads scoped event producers", async () => {
  const { path } = await fixture();
  assert.deepEqual(await loadEventCredentials(path), [producer]);
});

test("rejects invalid, duplicate and unrestricted producer credentials without disclosing tokens", async () => {
  for (const producers of [
    [],
    [{ ...producer, token: "short" }],
    [{ ...producer, sources: [] }],
    [{ ...producer, sources: ["bad source"] }],
    [producer, producer],
    [producer, { ...producer, id: "other" }],
    [producer, { ...producer, token: "b".repeat(32) }],
    [{ ...producer, extra: true }],
  ]) {
    const { path } = await fixture({ version: 1, producers });
    await assert.rejects(
      loadEventCredentials(path),
      (error: Error) => !error.message.includes(producer.token),
    );
  }
});

test("requires owned private regular credentials file and protected parent", async () => {
  const { root, path } = await fixture();
  await chmod(path, 0o644);
  await assert.rejects(loadEventCredentials(path), /0600/);
  await chmod(path, 0o600);
  await chmod(root, 0o755);
  await assert.rejects(loadEventCredentials(path), /parent/);
  await chmod(root, 0o700);
  const link = join(root, "link.json");
  await symlink(path, link);
  await assert.rejects(loadEventCredentials(link), /symbolic link/);
});

test("malformed credential JSON never appears in error text", async () => {
  const { path } = await fixture();
  await writeFile(path, `{"secret": ${producer.token}}`);
  await assert.rejects(
    loadEventCredentials(path),
    (error: Error) =>
      !error.message.includes(producer.token) && error.cause === undefined,
  );
});
