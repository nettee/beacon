import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isProcessAlive,
  isWorkerAdoptable,
  lifecyclePaths,
  prepareLifecycleDirectory,
  readWorkerCompletion,
  readWorkerRequest,
  resolveWorkerOutcomeSocketPath,
  UNIX_SOCKET_PATH_MAX_BYTES,
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

test("isWorkerAdoptable accepts a dead pid when completion.json exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-dead-done-"));
  await prepareLifecycleDirectory(root);
  await writeWorkerCompletion(root, {
    ok: true,
    result: {
      text: "done",
      provider: "test",
      model: "model",
      stopReason: "stop",
    },
    outcome: { reply: { kind: "no_reply", reason: "finished quietly" } },
    hasReply: true,
    finishedAt: new Date().toISOString(),
  });
  assert.equal(
    await isWorkerAdoptable({
      workerPid: 2_147_483_647,
      lifecycleDirectory: root,
      orphanAfterMs: 60_000,
    }),
    true,
  );
});

test("writeWorkerRequest + completion round-trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-req-"));
  const outcomes = await mkdtemp(join(tmpdir(), "beacon-outcomes-"));
  const outcomeSocketPath = resolveWorkerOutcomeSocketPath(
    outcomes,
    "run_eaf48791-8615-418c-ae45-2f657f3ce92e",
  );
  await writeWorkerRequest(root, {
    prompt: "hello",
    playbook: "/tmp/playbook",
    beaconCliPath: "/tmp/beacon",
    runToken: "token",
    outcomeSocketPath,
    supervisorLeasePath: "/tmp/lease",
  });
  const request = await readWorkerRequest(root);
  assert.equal(request.outcomeSocketPath, outcomeSocketPath);
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

test("worker outcome socket stays under macOS sun_path for Mini-shaped homes", () => {
  const home = "/Users/liuyi";
  const outcomesDirectory = join(home, ".beacon", "state", "outcomes");
  const runId = "run_eaf48791-8615-418c-ae45-2f657f3ce92e";
  const legacySessionSock = join(
    home,
    ".beacon",
    "sessions",
    "amr-galaxie",
    runId,
    "beacon-runtime",
    "outcomes.sock",
  );
  assert.equal(Buffer.byteLength(legacySessionSock, "utf8"), 111);
  assert.ok(
    Buffer.byteLength(legacySessionSock, "utf8") > UNIX_SOCKET_PATH_MAX_BYTES,
  );

  const shortSock = resolveWorkerOutcomeSocketPath(outcomesDirectory, runId);
  assert.match(shortSock, /\/[0-9a-f]{16}\.sock$/);
  assert.equal(shortSock.startsWith(`${outcomesDirectory}/`), true);
  const bytes = Buffer.byteLength(shortSock, "utf8");
  assert.equal(bytes, 57);
  assert.ok(bytes <= UNIX_SOCKET_PATH_MAX_BYTES);
  assert.equal(
    resolveWorkerOutcomeSocketPath(outcomesDirectory, runId),
    shortSock,
  );
});

test("resolveWorkerOutcomeSocketPath rejects oversize directories", () => {
  const oversized = `/${"x".repeat(90)}`;
  assert.throws(
    () => resolveWorkerOutcomeSocketPath(oversized, "run_too_long"),
    /exceeds Unix sun_path limit/,
  );
});

test("prepareLifecycleDirectory removes short outcome socket and legacy session sock", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-lifecycle-sock-"));
  const outcomes = await mkdtemp(join(tmpdir(), "beacon-outcomes-sock-"));
  const outcomeSocketPath = resolveWorkerOutcomeSocketPath(
    outcomes,
    "run_cleanup",
  );
  const paths = lifecyclePaths(root);
  await prepareLifecycleDirectory(root, { outcomeSocketPath });
  await writeFile(paths.legacyOutcomeSocket, "");
  await writeFile(outcomeSocketPath, "");
  await prepareLifecycleDirectory(root, { outcomeSocketPath });
  await assert.rejects(() => access(paths.legacyOutcomeSocket));
  await assert.rejects(() => access(outcomeSocketPath));
});
