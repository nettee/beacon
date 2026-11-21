import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listMergedRuntimeEnvironmentKeys,
  loadMergedRuntimeEnvironment,
  loadRuntimeEnvironment,
  profileRuntimeEnvironmentPath,
} from "./runtime-environment.js";

async function fixture(contents: string, mode = 0o600): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beacon-runtime-environment-"));
  const path = join(root, "runtime.env");
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
  return path;
}

test("returns an empty environment when runtime.env is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-runtime-environment-"));
  assert.deepEqual(await loadRuntimeEnvironment(join(root, "runtime.env")), {});
});

test("loads literal runtime variables without shell evaluation", async () => {
  const path = await fixture(`
# Production observability
GRAFANA_READER_TOKEN_PROD=reader-token
LITERAL_COMMAND=$(touch /tmp/must-not-run)
EMPTY=
`);
  assert.deepEqual(await loadRuntimeEnvironment(path), {
    GRAFANA_READER_TOKEN_PROD: "reader-token",
    LITERAL_COMMAND: "$(touch /tmp/must-not-run)",
    EMPTY: "",
  });
});

test("requires runtime.env mode 0600", async () => {
  const path = await fixture("SAFE=value\n", 0o640);
  await assert.rejects(loadRuntimeEnvironment(path), /mode 0600/);
});

for (const [name, contents, pattern] of [
  ["malformed entries", "NOT_AN_ASSIGNMENT\n", /expected KEY=VALUE/],
  ["invalid names", "BAD-NAME=value\n", /Invalid runtime environment/],
  ["duplicate names", "DUP=one\nDUP=two\n", /Duplicate runtime environment/],
  ["Beacon capabilities", "BEACON_RUN_TOKEN=value\n", /reserved/],
  ["Feishu credentials", "FEISHU_APP_SECRET=value\n", /reserved/],
  ["Node options", "NODE_OPTIONS=value\n", /reserved/],
] as const) {
  test(`rejects ${name}`, async () => {
    const path = await fixture(contents);
    await assert.rejects(loadRuntimeEnvironment(path), pattern);
  });
}

test("merges shared then profile with profile overriding same keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-runtime-merge-"));
  const sharedPath = join(root, "runtime.env");
  const profilePath = join(root, "profiles", "amr-galaxie", "runtime.env");
  await writeFile(
    sharedPath,
    "SHARED_ONLY=shared-secret\nOVERLAP=from-shared\n",
    { mode: 0o600 },
  );
  await chmod(sharedPath, 0o600);
  await mkdir(join(root, "profiles", "amr-galaxie"), { recursive: true });
  await writeFile(
    profilePath,
    "PROFILE_ONLY=profile-secret\nOVERLAP=from-profile\n",
    { mode: 0o600 },
  );
  await chmod(profilePath, 0o600);

  const merged = await loadMergedRuntimeEnvironment({
    sharedPath,
    profilePath,
  });
  assert.deepEqual(merged, {
    SHARED_ONLY: "shared-secret",
    OVERLAP: "from-profile",
    PROFILE_ONLY: "profile-secret",
  });

  const keys = await listMergedRuntimeEnvironmentKeys({
    sharedPath,
    profilePath,
  });
  assert.deepEqual(keys, ["OVERLAP", "PROFILE_ONLY", "SHARED_ONLY"]);
  const serialized = JSON.stringify({ keys });
  assert.doesNotMatch(serialized, /shared-secret/);
  assert.doesNotMatch(serialized, /profile-secret/);
  assert.doesNotMatch(serialized, /from-shared/);
  assert.doesNotMatch(serialized, /from-profile/);
});

test("merge treats missing shared or profile file as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-runtime-merge-absent-"));
  const sharedPath = join(root, "runtime.env");
  const profilePath = join(root, "profiles", "solo", "runtime.env");
  await mkdir(join(root, "profiles", "solo"), { recursive: true });
  await writeFile(profilePath, "SOLO=only-here\n", { mode: 0o600 });
  await chmod(profilePath, 0o600);

  assert.deepEqual(
    await loadMergedRuntimeEnvironment({ sharedPath, profilePath }),
    { SOLO: "only-here" },
  );
  assert.deepEqual(
    await listMergedRuntimeEnvironmentKeys({
      sharedPath: join(root, "missing-shared.env"),
      profilePath: join(root, "missing-profile.env"),
    }),
    [],
  );
});

test("profileRuntimeEnvironmentPath nests under the Profile directory", () => {
  assert.equal(
    profileRuntimeEnvironmentPath(
      "/home/beacon/.beacon/profiles",
      "amr-release",
    ),
    join("/home/beacon/.beacon/profiles", "amr-release", "runtime.env"),
  );
});
