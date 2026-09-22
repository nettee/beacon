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

test("fills Pi HTML systemPrompt from Beacon-owned text when JSONL has no system message", async () => {
  const { root, sessions } = await fixture();
  const exported = Buffer.from(
    JSON.stringify({ header: { id: "run_ok" }, systemPrompt: undefined }),
    "utf8",
  ).toString("base64");
  const executable = join(root, "pi");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '<script id="session-data" type="application/json">%s</script>' '${exported}' > "$3"\n`,
  );
  await chmod(executable, 0o700);
  const html = await exportSessionHtml({
    executable,
    sessionDirectory: sessions,
    runId: "run_ok",
    sessionPath: join(sessions, "alpha", "run_ok"),
    systemPrompt: "Beacon --system-prompt text",
  });
  const match = /id="session-data"[^>]*>([^<]*)<\/script>/.exec(html);
  assert.ok(match?.[1]);
  const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as {
    systemPrompt?: string;
  };
  assert.equal(data.systemPrompt, "Beacon --system-prompt text");
});

test("keeps the JSONL system fill when both JSONL and Beacon-owned text exist", async () => {
  const { root, sessions } = await fixture();
  const jsonl = join(
    sessions,
    "alpha",
    "run_ok",
    "2026-01-01T00-00-00Z_run_ok.jsonl",
  );
  await writeFile(
    jsonl,
    '{"type":"message","message":{"role":"system","content":"from jsonl"}}\n',
  );
  const exported = Buffer.from(
    JSON.stringify({ header: { id: "run_ok" }, systemPrompt: undefined }),
    "utf8",
  ).toString("base64");
  const executable = join(root, "pi");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '<script id="session-data" type="application/json">%s</script>' '${exported}' > "$3"\n`,
  );
  await chmod(executable, 0o700);
  const html = await exportSessionHtml({
    executable,
    sessionDirectory: sessions,
    runId: "run_ok",
    sessionPath: join(sessions, "alpha", "run_ok"),
    systemPrompt: "from beacon run record",
  });
  const match = /id="session-data"[^>]*>([^<]*)<\/script>/.exec(html);
  assert.ok(match?.[1]);
  const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as {
    systemPrompt?: string;
  };
  assert.equal(data.systemPrompt, "from jsonl");
});

test("fills Pi HTML systemPrompt from the session JSONL system message", async () => {
  const { root, sessions } = await fixture();
  const jsonl = join(
    sessions,
    "alpha",
    "run_ok",
    "2026-01-01T00-00-00Z_run_ok.jsonl",
  );
  await writeFile(
    jsonl,
    [
      '{"type":"session","id":"run_ok"}',
      '{"type":"message","message":{"role":"system","content":"","sections":{"preamble":"You are Beacon."}}}',
      '{"type":"message","message":{"role":"user","content":"hello"}}',
      "",
    ].join("\n"),
  );
  const exported = Buffer.from(
    JSON.stringify({ header: { id: "run_ok" }, systemPrompt: undefined }),
    "utf8",
  ).toString("base64");
  const executable = join(root, "pi");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '<script id="session-data" type="application/json">%s</script>' '${exported}' > "$3"\n`,
  );
  await chmod(executable, 0o700);
  const html = await exportSessionHtml({
    executable,
    sessionDirectory: sessions,
    runId: "run_ok",
    sessionPath: join(sessions, "alpha", "run_ok"),
  });
  const match = /id="session-data"[^>]*>([^<]*)<\/script>/.exec(html);
  assert.ok(match?.[1]);
  const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as {
    systemPrompt?: string;
  };
  assert.equal(data.systemPrompt, "You are Beacon.");
});

test("fills Pi HTML Feedback from a Beacon-owned empty list", async () => {
  const { root, sessions } = await fixture();
  const exported = Buffer.from(
    JSON.stringify({ header: { id: "run_ok" }, systemPrompt: undefined }),
    "utf8",
  ).toString("base64");
  const executable = join(root, "pi");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '<script id="session-data" type="application/json">%s</script>' '${exported}' > "$3"\n`,
  );
  await chmod(executable, 0o700);
  const html = await exportSessionHtml({
    executable,
    sessionDirectory: sessions,
    runId: "run_ok",
    sessionPath: join(sessions, "alpha", "run_ok"),
    feedback: { items: [], submittedAt: "2026-09-22T02:00:00.000Z" },
  });
  assert.match(html, />无问题</);
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
