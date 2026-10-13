import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isProcessAlive,
  isWorkerAdoptable,
  lifecyclePaths,
  prepareLifecycleDirectory,
  readWorkerCompletion,
  writeWorkerCompletion,
  writeWorkerHeartbeat,
  writeWorkerPid,
  writeWorkerRequest,
} from "./pi-worker-lifecycle.js";

test("prepareLifecycleDirectory clears prior completion artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-lifecycle-"));
  const paths = lifecyclePaths(root);
  await prepareLifecycleDirectory(root);
  await writeFile(paths.completion, '{"ok":false}\n');
  await prepareLifecycleDirectory(root);
  assert.equal(await readWorkerCompletion(root), undefined);
});

test("isWorkerAdoptable accepts a live pid with fresh heartbeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-adopt-"));
  await prepareLifecycleDirectory(root);
  await writeWorkerPid(root, process.pid);
  await writeWorkerHeartbeat(root);
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(
    await isWorkerAdoptable({
      workerPid: process.pid,
      lifecycleDirectory: root,
      orphanAfterMs: 60_000,
    }),
    true,
  );
});

test("isWorkerAdoptable rejects a dead pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-dead-"));
  await prepareLifecycleDirectory(root);
  assert.equal(
    await isWorkerAdoptable({
      workerPid: 2_147_483_647,
      lifecycleDirectory: root,
      orphanAfterMs: 60_000,
    }),
    false,
  );
});

test("writeWorkerRequest + completion round-trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-req-"));
  await writeWorkerRequest(root, {
    prompt: "hello",
    playbook: "/tmp/playbook",
    beaconCliPath: "/tmp/beacon",
    runToken: "token",
    supervisorLeasePath: "/tmp/lease",
  });
  await writeWorkerCompletion(root, {
    ok: true,
    result: {
      text: "done",
      provider: "test",
      model: "model",
      stopReason: "stop",
    },
    outcome: { reply: { kind: "text", text: "done" } },
    hasReply: true,
    finishedAt: new Date().toISOString(),
  });
  const completion = await readWorkerCompletion(root);
  assert.equal(completion?.ok, true);
  if (completion?.ok) {
    assert.equal(completion.result.text, "done");
  }
});
