import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startDashboard } from "./server.js";

async function fixture(): Promise<{
  profiles: string;
  sessions: string;
  executable: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "beacon-dashboard-http-"));
  const profiles = join(root, "profiles");
  const sessions = join(root, "sessions");
  const sessionPath = join(sessions, "alpha", "run_ok");
  await mkdir(join(profiles, "alpha", "state", "triggers", "aa"), {
    recursive: true,
  });
  await mkdir(sessionPath, { recursive: true });
  await writeFile(join(sessionPath, "session.jsonl"), '{"type":"session"}\n');
  await writeFile(
    join(profiles, "alpha", "state", "triggers", "aa", "record.json"),
    JSON.stringify({
      triggerKey: "aa",
      profileId: "alpha",
      acceptedAt: "2026-01-02T00:00:00.000Z",
      input: { kind: "manual" },
      run: {
        runId: "run_ok",
        state: "succeeded",
        sessionPath,
      },
    }),
  );
  const executable = join(root, "pi");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf \'<html>pi-html:%s</html>\' "$2" > "$3"\n',
  );
  await chmod(executable, 0o700);
  return { profiles, sessions, executable };
}

test("serves the React shell, run JSON, and exported Pi HTML", async () => {
  const { profiles, sessions, executable } = await fixture();
  const uiDirectory = await mkdtemp(join(tmpdir(), "beacon-ui-"));
  await writeFile(
    join(uiDirectory, "index.html"),
    '<!doctype html><title>Beacon Runs UI</title><div id="root"></div>\n',
  );
  const server = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
    uiDirectory,
  });
  try {
    const origin = `http://127.0.0.1:${String(server.port)}`;
    const list = await fetch(origin);
    assert.equal(list.status, 200);
    assert.match(await list.text(), /Beacon Runs UI/);
    const api = await fetch(`${origin}/api/runs`);
    assert.equal(api.status, 200);
    const payload = (await api.json()) as {
      runs: Array<{
        runId: string;
        kindLabel: string;
        hasSessionFile: boolean;
      }>;
    };
    assert.equal(payload.runs[0]?.runId, "run_ok");
    assert.equal(payload.runs[0]?.hasSessionFile, true);
    const page = await fetch(`${origin}/runs/run_ok`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /pi-html:.*session\.jsonl/);
    const missing = await fetch(`${origin}/runs/run_unknown`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("fails to bind a port that is already in use", async () => {
  const { profiles, sessions, executable } = await fixture();
  const first = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
  });
  try {
    await assert.rejects(
      startDashboard({
        listen: "127.0.0.1",
        port: first.port,
        profilesDirectory: profiles,
        sessionDirectory: sessions,
        piExecutable: executable,
      }),
      /EADDRINUSE/,
    );
  } finally {
    await first.close();
  }
});
