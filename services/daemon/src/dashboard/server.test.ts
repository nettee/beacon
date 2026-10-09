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

test("fills exported HTML from a stored Run systemPrompt", async () => {
  const { profiles, sessions, executable } = await fixture();
  const exported = Buffer.from(
    JSON.stringify({ header: { id: "run_ok" }, systemPrompt: undefined }),
    "utf8",
  ).toString("base64");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '<script id="session-data" type="application/json">%s</script>' '${exported}' > "$3"\n`,
  );
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
        sessionPath: join(sessions, "alpha", "run_ok"),
        systemPrompt: "stored Beacon --system-prompt",
      },
    }),
  );
  const server = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
  });
  try {
    const page = await fetch(
      `http://127.0.0.1:${String(server.port)}/runs/run_ok`,
    );
    assert.equal(page.status, 200);
    const html = await page.text();
    const match = /id="session-data"[^>]*>([^<]*)<\/script>/.exec(html);
    assert.ok(match?.[1]);
    const data = JSON.parse(
      Buffer.from(match[1], "base64").toString("utf8"),
    ) as {
      systemPrompt?: string;
    };
    assert.equal(data.systemPrompt, "stored Beacon --system-prompt");
  } finally {
    await server.close();
  }
});

test("reconstructs HTML systemPrompt from current persona.md and task.md for old Runs", async () => {
  const { profiles, sessions, executable } = await fixture();
  await writeFile(
    join(profiles, "alpha", "profile.yaml"),
    [
      "playbook: .",
      "runtime: pi",
      "model:",
      "  provider: test",
      "  id: model",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(profiles, "alpha", "persona.md"),
    "You are reconstructed.",
  );
  await writeFile(
    join(profiles, "alpha", "task.md"),
    "Follow the reconstructed task.",
  );
  const exported = Buffer.from(
    JSON.stringify({ header: { id: "run_ok" }, systemPrompt: undefined }),
    "utf8",
  ).toString("base64");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '<script id="session-data" type="application/json">%s</script>' '${exported}' > "$3"\n`,
  );
  const server = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
  });
  try {
    const page = await fetch(
      `http://127.0.0.1:${String(server.port)}/runs/run_ok`,
    );
    assert.equal(page.status, 200);
    const html = await page.text();
    const match = /id="session-data"[^>]*>([^<]*)<\/script>/.exec(html);
    assert.ok(match?.[1]);
    const data = JSON.parse(
      Buffer.from(match[1], "base64").toString("utf8"),
    ) as {
      systemPrompt?: string;
    };
    assert.match(data.systemPrompt ?? "", /You are reconstructed\./);
    assert.match(data.systemPrompt ?? "", /Follow the reconstructed task\./);
    assert.match(
      data.systemPrompt ?? "",
      /All local file reads, searches, and modifications must stay within the playbook directory/,
    );
    assert.match(
      data.systemPrompt ?? "",
      /This Run is a manual operator trigger/,
    );
    const personaAt = (data.systemPrompt ?? "").indexOf(
      "You are reconstructed.",
    );
    const playbookAt = (data.systemPrompt ?? "").indexOf(
      "All local file reads, searches, and modifications",
    );
    assert.ok(playbookAt >= 0 && playbookAt < personaAt);
  } finally {
    await server.close();
  }
});

test("serves profile list and detail JSON without secrets", async () => {
  const { profiles, sessions, executable } = await fixture();
  await writeFile(
    join(profiles, "alpha", "profile.yaml"),
    [
      "playbook: .",
      "runtime: pi",
      "model:",
      "  provider: deepseek",
      "  id: deepseek-flash",
      "admin:",
      "  chat_id: oc_admin_alpha",
      "schedules:",
      "  - id: weekday-brief",
      '    cron: "0 9 * * 1-5"',
      "    timezone: Asia/Shanghai",
      "    input: Prepare the weekday brief.",
      "    notify:",
      "      name: weekday-brief-group",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(profiles, "..", "secrets.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        alpha: {
          feishu: {
            app_id: "cli_0123456789abcdef",
            app_secret: "should-not-leak",
          },
        },
      },
    }),
  );
  const server = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
  });
  try {
    const origin = `http://127.0.0.1:${String(server.port)}`;
    const list = await fetch(`${origin}/api/profiles`);
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      profiles: Array<{ id: string; scheduleCount: number }>;
    };
    assert.equal(listBody.profiles[0]?.id, "alpha");
    assert.equal(listBody.profiles[0]?.scheduleCount, 1);

    const detail = await fetch(`${origin}/api/profiles/alpha`);
    assert.equal(detail.status, 200);
    const detailText = await detail.text();
    assert.doesNotMatch(detailText, /should-not-leak/);
    assert.doesNotMatch(detailText, /app_secret/);
    const detailBody = JSON.parse(detailText) as {
      profile: {
        id: string;
        admin: { chatId: string } | null;
        schedules: Array<{
          notify: { kind: string; name?: string } | null;
        }>;
        secrets: { present: boolean };
      };
    };
    assert.equal(detailBody.profile.id, "alpha");
    assert.equal(detailBody.profile.admin?.chatId, "oc_admin_alpha");
    assert.equal(detailBody.profile.schedules[0]?.notify?.kind, "channel");
    assert.equal(
      detailBody.profile.schedules[0]?.notify?.name,
      "weekday-brief-group",
    );
    assert.equal(detailBody.profile.secrets.present, false);

    const missing = await fetch(`${origin}/api/profiles/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("lists stored feedback items on the run JSON and omits them when absent", async () => {
  const { profiles, sessions, executable } = await fixture();
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
        sessionPath: join(sessions, "alpha", "run_ok"),
      },
      feedback: {
        items: [
          {
            priority: "high",
            summary: "GRAFANA_READER_TOKEN_PROD is unset.",
          },
        ],
        submittedAt: "2026-01-02T00:01:00.000Z",
      },
      observabilityFeedback: {
        items: [
          {
            priority: "medium",
            summary: "Alert series lacks a deploy annotation.",
          },
        ],
        submittedAt: "2026-01-02T00:01:05.000Z",
      },
    }),
  );
  const server = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
  });
  try {
    const withFeedback = await fetch(
      `http://127.0.0.1:${String(server.port)}/api/runs`,
    );
    assert.equal(withFeedback.status, 200);
    const payload = (await withFeedback.json()) as {
      runs: Array<{
        runId: string;
        feedback: Array<{ priority: string; summary: string }> | null;
        observabilityFeedback: Array<{
          priority: string;
          summary: string;
        }> | null;
      }>;
    };
    assert.deepEqual(payload.runs[0]?.feedback, [
      {
        priority: "high",
        summary: "GRAFANA_READER_TOKEN_PROD is unset.",
      },
    ]);
    assert.deepEqual(payload.runs[0]?.observabilityFeedback, [
      {
        priority: "medium",
        summary: "Alert series lacks a deploy annotation.",
      },
    ]);
  } finally {
    await server.close();
  }

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
        sessionPath: join(sessions, "alpha", "run_ok"),
      },
    }),
  );
  const again = await startDashboard({
    listen: "127.0.0.1",
    port: 0,
    profilesDirectory: profiles,
    sessionDirectory: sessions,
    piExecutable: executable,
  });
  try {
    const without = await fetch(
      `http://127.0.0.1:${String(again.port)}/api/runs`,
    );
    const payload = (await without.json()) as {
      runs: Array<{
        feedback: unknown;
        observabilityFeedback: unknown;
      }>;
    };
    assert.equal(payload.runs[0]?.feedback, null);
    assert.equal(payload.runs[0]?.observabilityFeedback, null);
  } finally {
    await again.close();
  }
});
