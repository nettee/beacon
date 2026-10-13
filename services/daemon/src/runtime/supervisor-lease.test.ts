import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isSupervisorLeaseFresh,
  readSupervisorLease,
  writeSupervisorLease,
} from "./supervisor-lease.js";

test("writeSupervisorLease creates a fresh lease file", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-lease-"));
  const path = join(root, "state", "supervisor.lease");
  await writeSupervisorLease(path);
  const lease = await readSupervisorLease(path);
  assert.ok(lease);
  assert.equal(lease.pid, process.pid);
  assert.equal(await isSupervisorLeaseFresh(path, 60_000), true);
  const raw = await readFile(path, "utf8");
  assert.match(raw, /updatedAt/);
});

test("isSupervisorLeaseFresh is false when stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-lease-stale-"));
  const path = join(root, "supervisor.lease");
  await writeSupervisorLease(path);
  assert.equal(
    await isSupervisorLeaseFresh(path, 1, Date.now() + 1_000),
    false,
  );
});
