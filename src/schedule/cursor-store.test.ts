import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleCursorStore } from "./cursor-store.js";

test("persists a cursor and refuses to move it backwards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-cursor-"));
  const store = new ScheduleCursorStore(directory);
  await store.initialize("daily", new Date("2026-09-13T00:00:00.000Z"));
  await store.advance("daily", new Date("2026-09-13T01:00:00.000Z"));
  assert.equal(
    (await store.read("daily"))?.through,
    "2026-09-13T01:00:00.000Z",
  );
  await assert.rejects(
    store.advance("daily", new Date("2026-09-13T00:59:00.000Z")),
    /cannot move backwards/,
  );
});

test("fails visibly on a corrupted cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-cursor-"));
  const root = join(directory, "state", "schedules");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "daily.json"), "not-json\n");
  await assert.rejects(
    new ScheduleCursorStore(directory).read("daily"),
    /Invalid Schedule cursor/,
  );
});
