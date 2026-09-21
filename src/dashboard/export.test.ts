import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exportSessionHtml, resolveSessionJsonl } from "./export.js";

async function fixture(): Promise<{
  root: string;
  sessions: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "beacon-dashboard-export-"));
  const sessions = join(root, "sessions");
  await mkdir(join(sessions, "alpha", "run_ok"), { recursive: true });
  await writeFile(
    join(sessions, "alpha", "run_ok", "2026-01-01T00-00-00Z_run_ok.jsonl"),
    '{"type":"session","id":"run_ok"}\n',
  );
  return { root, sessions };
}

test("exports HTML through Pi --export after jailing the session path", async () => {
  const { root, sessions } = await fixture();
  const executable = join(root, "pi");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf \'exported:%s\' "$2" > "$3"\n',
  );
  await chmod(executable, 0o700);
  const html = await exportSessionHtml({
    executable,
    sessionDirectory: sessions,
    runId: "run_ok",
    sessionPath: join(sessions, "alpha", "run_ok"),
  });
  assert.match(html, /exported:.*run_ok\.jsonl/);
});

test("rejects a session path outside the configured directory", async () => {
  const { root, sessions } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.jsonl"), "nope\n");
  await symlink(outside, join(sessions, "alpha", "run_link"));
  await assert.rejects(
    resolveSessionJsonl(
      sessions,
      "run_link",
      join(sessions, "alpha", "run_link"),
    ),
    /outside/,
  );
});
