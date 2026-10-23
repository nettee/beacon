import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isSupervisorLeaseFresh,
  readSupervisorLease,
  startSupervisorLeaseWriter,
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

test("concurrent writeSupervisorLease leaves a readable fresh lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-lease-concurrent-"));
  const path = join(root, "supervisor.lease");
  await Promise.all(
    Array.from({ length: 32 }, () => writeSupervisorLease(path)),
  );
  const lease = await readSupervisorLease(path);
  assert.ok(lease, "lease file must remain readable after concurrent writes");
  assert.equal(lease.pid, process.pid);
  assert.equal(await isSupervisorLeaseFresh(path, 60_000), true);
  const raw = await readFile(path, "utf8");
  assert.match(raw, /"updatedAt":"/);
});

test("startSupervisorLeaseWriter serializes overlapping ticks", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "beacon-lease-serialize-")),
    "supervisor.lease",
  );
  let active = 0;
  let maxActive = 0;
  let releases = 0;
  const gates: Array<() => void> = [];

  const handle = startSupervisorLeaseWriter(path, {
    intervalMs: 5,
    write: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      active -= 1;
      releases += 1;
    },
  });

  try {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (gates.length >= 1) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
    // Allow several intervals while the first write is still held open.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(gates.length, 1, "in-flight tick must skip further writes");
    assert.equal(maxActive, 1);
    for (const release of gates.splice(0)) release();
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (releases >= 1 && gates.length >= 1) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
    assert.equal(maxActive, 1);
  } finally {
    handle.stop();
    for (const release of gates.splice(0)) release();
  }
});

test("startSupervisorLeaseWriter escalates continuous failure logs", async () => {
  const logs: string[] = [];
  let clock = 5_000_000;
  let calls = 0;
  const writer = startSupervisorLeaseWriter("/tmp/unused-lease", {
    intervalMs: 10,
    orphanAfterMs: 100,
    now: () => clock,
    logError: (message) => {
      logs.push(message);
    },
    write: async () => {
      calls += 1;
      throw new Error("disk full");
    },
  });

  try {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (logs.length >= 1) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
    assert.match(logs[0]!, /failed to refresh supervisor lease/);
    assert.match(logs[0]!, /consecutiveFailures=1/);
    assert.match(logs[0]!, /staleMs=0/);

    clock += 60;
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (logs.length >= 2) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
    assert.ok(calls >= 2);
    assert.match(logs[1]!, /supervisor lease refresh failing critically/);
    assert.match(logs[1]!, /consecutiveFailures=2/);
    assert.match(logs[1]!, /staleMs=60/);
    assert.match(logs[1]!, /disk full/);
    assert.match(logs[1]!, /at=/);
  } finally {
    writer.stop();
  }
});
