import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listModelAllocations,
  ModelAllocationError,
  matchDashboardModelKey,
  parseModelAllocationPercents,
  putModelAllocation,
} from "./model-allocation.js";

async function writeProfile(
  profiles: string,
  id: string,
  yaml: string,
): Promise<void> {
  await mkdir(join(profiles, id), { recursive: true });
  await writeFile(join(profiles, id, "profile.yaml"), yaml);
}

test("matchDashboardModelKey matches whitelist only", () => {
  assert.equal(
    matchDashboardModelKey({
      provider: "openai-codex",
      id: "gpt-6-luna",
      thinking: "high",
    }),
    "gpt-6-luna-high",
  );
  assert.equal(
    matchDashboardModelKey({
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    }),
    "deepseek-v4.1-flash",
  );
  assert.equal(
    matchDashboardModelKey({
      provider: "openai-codex",
      id: "gpt-6-luna",
      thinking: "medium",
    }),
    null,
  );
  assert.equal(
    matchDashboardModelKey({
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      thinking: "high",
    }),
    null,
  );
});

test("parseModelAllocationPercents requires sum 100 and whitelist keys", () => {
  assert.deepEqual(
    parseModelAllocationPercents({
      percents: {
        "gpt-6-luna-high": 70,
        "deepseek-v4.1-flash": 30,
      },
    }),
    {
      "gpt-6-luna-high": 70,
      "deepseek-v4.1-flash": 30,
    },
  );
  assert.throws(
    () =>
      parseModelAllocationPercents({
        percents: {
          "gpt-6-luna-high": 50,
          "deepseek-v4.1-flash": 40,
        },
      }),
    (error: unknown) =>
      error instanceof ModelAllocationError &&
      error.status === 400 &&
      /sum to 100/.test(error.message),
  );
  assert.throws(
    () =>
      parseModelAllocationPercents({
        percents: {
          "gpt-6-luna-high": 100,
          "deepseek-v4.1-flash": 0,
          other: 0,
        },
      }),
    (error: unknown) =>
      error instanceof ModelAllocationError &&
      /Unknown model key/.test(error.message),
  );
  assert.throws(
    () =>
      parseModelAllocationPercents({
        percents: { "gpt-6-luna-high": 100 },
      }),
    (error: unknown) =>
      error instanceof ModelAllocationError &&
      /Missing percent/.test(error.message),
  );
});

test("lists single-model and pool allocations mapped to whitelist", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-list-"));
  const profiles = join(root, "profiles");
  await writeProfile(
    profiles,
    "pinned",
    [
      "playbook: /tmp/p",
      "runtime: pi",
      "model:",
      "  provider: opencode-go",
      "  id: deepseek-v4.1-flash",
      "",
    ].join("\n"),
  );
  await writeProfile(
    profiles,
    "alert-manager",
    [
      "playbook: /tmp/a",
      "runtime: pi",
      "model:",
      "  provider: opencode-go",
      "  id: deepseek-v4.1-flash",
      "model_pool:",
      "  - provider: opencode-go",
      "    id: deepseek-v4.1-flash",
      "    weight: 50",
      "  - provider: openai-codex",
      "    id: gpt-6-luna",
      "    thinking: high",
      "    weight: 50",
      "",
    ].join("\n"),
  );
  await writeProfile(
    profiles,
    "other",
    [
      "playbook: /tmp/o",
      "runtime: pi",
      "model:",
      "  provider: deepseek",
      "  id: deepseek-flash",
      "",
    ].join("\n"),
  );

  const response = await listModelAllocations(profiles);
  assert.equal(response.appliesOnRestart, true);
  assert.equal(response.choices.length, 2);

  const pinned = response.profiles.find((row) => row.profileId === "pinned");
  assert.ok(pinned);
  assert.equal(pinned.mode, "single");
  assert.equal(pinned.mapped, true);
  assert.equal(
    pinned.allocations.find((a) => a.key === "deepseek-v4.1-flash")?.percent,
    100,
  );
  assert.equal(
    pinned.allocations.find((a) => a.key === "gpt-6-luna-high")?.percent,
    0,
  );

  const pool = response.profiles.find(
    (row) => row.profileId === "alert-manager",
  );
  assert.ok(pool);
  assert.equal(pool.mode, "pool");
  assert.equal(pool.mapped, true);
  assert.equal(
    pool.allocations.find((a) => a.key === "deepseek-v4.1-flash")?.percent,
    50,
  );
  assert.equal(
    pool.allocations.find((a) => a.key === "gpt-6-luna-high")?.percent,
    50,
  );

  const other = response.profiles.find((row) => row.profileId === "other");
  assert.ok(other);
  assert.equal(other.mapped, false);
});

test("putModelAllocation writes pool and pins 100% single model", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-put-"));
  const profiles = join(root, "profiles");
  await writeProfile(
    profiles,
    "alert-manager",
    [
      "playbook: /tmp/a",
      "runtime: pi",
      "model:",
      "  provider: opencode-go",
      "  id: deepseek-v4.1-flash",
      "admin:",
      "  chat_id: oc_admin",
      "schedules: []",
      "",
    ].join("\n"),
  );

  const split = await putModelAllocation(profiles, "alert-manager", {
    percents: {
      "gpt-6-luna-high": 70,
      "deepseek-v4.1-flash": 30,
    },
  });
  assert.equal(split.appliesOnRestart, true);
  assert.equal(split.profile.mode, "pool");
  assert.equal(split.profile.mapped, true);
  assert.deepEqual(split.profile.modelPool, [
    {
      provider: "openai-codex",
      id: "gpt-6-luna",
      thinking: "high",
      weight: 70,
    },
    {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      weight: 30,
    },
  ]);
  // Higher percent wins primary.
  assert.deepEqual(split.profile.model, {
    provider: "openai-codex",
    id: "gpt-6-luna",
    thinking: "high",
  });

  const yamlAfterPool = await readFile(
    join(profiles, "alert-manager", "profile.yaml"),
    "utf8",
  );
  assert.match(yamlAfterPool, /model_pool:/);
  assert.match(yamlAfterPool, /chat_id: oc_admin/);

  const pinned = await putModelAllocation(profiles, "alert-manager", {
    percents: {
      "gpt-6-luna-high": 0,
      "deepseek-v4.1-flash": 100,
    },
  });
  assert.equal(pinned.profile.mode, "single");
  assert.equal(pinned.profile.modelPool, null);
  assert.deepEqual(pinned.profile.model, {
    provider: "opencode-go",
    id: "deepseek-v4.1-flash",
  });
  const yamlPinned = await readFile(
    join(profiles, "alert-manager", "profile.yaml"),
    "utf8",
  );
  assert.doesNotMatch(yamlPinned, /model_pool:/);
  assert.match(yamlPinned, /chat_id: oc_admin/);
});

test("putModelAllocation rejects unknown profile and bad body", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-err-"));
  const profiles = join(root, "profiles");
  await writeProfile(
    profiles,
    "alpha",
    [
      "playbook: /tmp/a",
      "runtime: pi",
      "model:",
      "  provider: opencode-go",
      "  id: deepseek-v4.1-flash",
      "",
    ].join("\n"),
  );
  await assert.rejects(
    putModelAllocation(profiles, "missing", {
      percents: {
        "gpt-6-luna-high": 50,
        "deepseek-v4.1-flash": 50,
      },
    }),
    (error: unknown) =>
      error instanceof ModelAllocationError && error.status === 404,
  );
  await assert.rejects(
    putModelAllocation(profiles, "alpha", { percents: { nope: 100 } }),
    (error: unknown) =>
      error instanceof ModelAllocationError && error.status === 400,
  );
});
