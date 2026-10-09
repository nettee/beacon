import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getProfileDetailView, listProfileViews } from "./profiles.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beacon-dashboard-profiles-"));
  const profiles = join(root, "profiles");
  await mkdir(join(profiles, "amr-release"), { recursive: true });
  await mkdir(join(profiles, "beacon-test"), { recursive: true });
  await mkdir(join(profiles, "broken"), { recursive: true });
  await writeFile(
    join(profiles, "amr-release", "profile.yaml"),
    [
      "playbook: /tmp/workspace",
      "runtime: pi",
      "model:",
      "  provider: deepseek",
      "  id: deepseek-flash",
      "admin:",
      "  chat_id: oc_admin_release",
      "schedules:",
      "  - id: daily-release-impact",
      '    cron: "0 10 * * 1-5"',
      "    timezone: Asia/Shanghai",
      "    input: Analyze release impact.",
      "    notify:",
      "      name: amr-development-group",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(profiles, "beacon-test", "profile.yaml"),
    [
      "playbook: /tmp/test-workspace",
      "runtime: pi",
      "model:",
      "  provider: deepseek",
      "  id: deepseek-flash",
      "admin:",
      "  chat_id: oc_admin_test",
      "schedules: []",
      "listener:",
      "  sources:",
      "    - urn:beacon:test",
      "  types:",
      "    - com.beacon.test.v1",
      "",
    ].join("\n"),
  );
  await writeFile(join(profiles, "broken", "profile.yaml"), "runtime: pi\n");
  // secrets.json must never be read by the dashboard profiles API
  await writeFile(
    join(root, "secrets.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        "amr-release": {
          feishu: {
            app_id: "cli_0123456789abcdef",
            app_secret: "super-secret-value",
          },
        },
      },
    }),
  );
  return profiles;
}

test("lists profiles from profile.yaml without reading secrets", async () => {
  const profiles = await fixture();
  const rows = await listProfileViews(profiles);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.id, "amr-release");
  assert.equal(rows[0]?.scheduleCount, 1);
  assert.equal(rows[0]?.hasAdmin, true);
  assert.equal(rows[0]?.error, null);
  assert.equal(rows[1]?.id, "beacon-test");
  assert.equal(rows[1]?.hasListener, true);
  assert.equal(rows[2]?.id, "broken");
  assert.ok(rows[2]?.error);
});

test("returns profile detail with channel notify references and no secrets", async () => {
  const profiles = await fixture();
  const detail = await getProfileDetailView(profiles, "amr-release");
  assert.ok(detail);
  assert.equal(detail.playbook, "/tmp/workspace");
  assert.deepEqual(detail.model, {
    provider: "deepseek",
    id: "deepseek-flash",
  });
  assert.deepEqual(detail.admin, { chatId: "oc_admin_release" });
  assert.equal(detail.schedules[0]?.notify?.kind, "channel");
  assert.equal(
    detail.schedules[0]?.notify && detail.schedules[0].notify.kind === "channel"
      ? detail.schedules[0].notify.name
      : null,
    "amr-development-group",
  );
  assert.equal(detail.skills, null);
  assert.equal(detail.secrets.present, false);
  assert.match(detail.secrets.note, /secrets\.json/);
  const serialized = JSON.stringify(detail);
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.doesNotMatch(serialized, /cli_0123456789abcdef/);
  assert.doesNotMatch(serialized, /app_secret/);
});

test("returns null for missing profiles", async () => {
  const profiles = await fixture();
  assert.equal(await getProfileDetailView(profiles, "missing"), null);
  assert.equal(await getProfileDetailView(profiles, "../etc"), null);
});

test("returns explicit skills paths from profile.yaml without resolving them", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-dashboard-skills-"));
  const profiles = join(root, "profiles");
  await mkdir(join(profiles, "pinned"), { recursive: true });
  await writeFile(
    join(profiles, "pinned", "profile.yaml"),
    [
      "playbook: /tmp/workspace",
      "runtime: pi",
      "model:",
      "  provider: deepseek",
      "  id: deepseek-flash",
      "skills:",
      "  mode: explicit",
      "  paths:",
      "    - ~/.agents/skills/tea-cli",
      "    - skills/local",
      "",
    ].join("\n"),
  );
  const detail = await getProfileDetailView(profiles, "pinned");
  assert.deepEqual(detail?.skills, {
    mode: "explicit",
    paths: ["~/.agents/skills/tea-cli", "skills/local"],
  });
});

test("rejects legacy workspace key in dashboard profile views", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-dashboard-legacy-"));
  const profiles = join(root, "profiles");
  await mkdir(join(profiles, "legacy"), { recursive: true });
  await writeFile(
    join(profiles, "legacy", "profile.yaml"),
    [
      "workspace: /tmp/legacy-workspace",
      "runtime: pi",
      "model:",
      "  provider: deepseek",
      "  id: deepseek-flash",
      "",
    ].join("\n"),
  );
  const rows = await listProfileViews(profiles);
  assert.equal(rows[0]?.playbook, "");
  assert.match(rows[0]?.error ?? "", /Unrecognized key|Required/i);
  await assert.rejects(
    getProfileDetailView(profiles, "legacy"),
    /Unrecognized key|Required/i,
  );
});
