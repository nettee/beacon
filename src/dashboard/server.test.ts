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

test("serves the run list and exported Pi HTML", async () => {
  const { profiles, sessions, executable } = await fixture();
  const server = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
  });
  try {
    const origin = `http://127.0.0.1:${String(server.port)}`;
    const list = await fetch(origin);
    assert.equal(list.status, 200);
    const listHtml = await list.text();
    assert.match(listHtml, /run_ok/);
    assert.match(listHtml, /href="\/runs\/run_ok"/);
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
