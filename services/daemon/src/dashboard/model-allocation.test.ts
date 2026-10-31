import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type Profile,
  patchProfileModelFields,
  selectProfileModel,
} from "../config/profile.js";
import {
  DASHBOARD_MODEL_CHOICES,
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
      provider: "deepseek",
      id: "deepseek-flash",
      thinking: "high",
    }),
    "deepseek-flash-high",
  );
  assert.equal(
    matchDashboardModelKey({
      provider: "openai-codex",
      id: "gpt-6.1-terra",
      thinking: "high",
    }),
    "gpt-6.1-terra-high",
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
      provider: "openai-codex",
      id: "gpt-6.1-terra",
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
  // Official deepseek without thinking must not match the high choice.
  assert.equal(
    matchDashboardModelKey({
      provider: "deepseek",
      id: "deepseek-flash",
    }),
    null,
  );
});

test("DASHBOARD_MODEL_CHOICES labels use provider / id [/ thinking]", () => {
  assert.deepEqual(
    DASHBOARD_MODEL_CHOICES.map((choice) => ({
      key: choice.key,
      label: choice.label,
    })),
    [
      {
        key: "gpt-6-luna-high",
        label: "openai-codex / gpt-6-luna / high",
      },
      {
        key: "deepseek-v4.1-flash",
        label: "opencode-go / deepseek-v4.1-flash",
      },
      {
        key: "deepseek-flash-high",
        label: "deepseek / deepseek-flash / high",
      },
      {
        key: "gpt-6.1-terra-high",
        label: "openai-codex / gpt-6.1-terra / high",
      },
    ],
  );
});

test("parseModelAllocationPercents requires sum 100 and whitelist keys", () => {
  assert.deepEqual(
    parseModelAllocationPercents({
      percents: {
        "gpt-6-luna-high": 70,
        "deepseek-v4.1-flash": 30,
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 0,
      },
    }),
    {
      "gpt-6-luna-high": 70,
      "deepseek-v4.1-flash": 30,
      "deepseek-flash-high": 0,
      "gpt-6.1-terra-high": 0,
    },
  );
  assert.deepEqual(
    parseModelAllocationPercents({
      percents: {
        "gpt-6-luna-high": 0,
        "deepseek-v4.1-flash": 0,
        "deepseek-flash-high": 100,
        "gpt-6.1-terra-high": 0,
      },
    }),
    {
      "gpt-6-luna-high": 0,
      "deepseek-v4.1-flash": 0,
      "deepseek-flash-high": 100,
      "gpt-6.1-terra-high": 0,
    },
  );
  assert.deepEqual(
    parseModelAllocationPercents({
      percents: {
        "gpt-6-luna-high": 0,
        "deepseek-v4.1-flash": 0,
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 100,
      },
    }),
    {
      "gpt-6-luna-high": 0,
      "deepseek-v4.1-flash": 0,
      "deepseek-flash-high": 0,
      "gpt-6.1-terra-high": 100,
    },
  );
  assert.throws(
    () =>
      parseModelAllocationPercents({
        percents: {
          "gpt-6-luna-high": 50,
          "deepseek-v4.1-flash": 40,
          "deepseek-flash-high": 0,
          "gpt-6.1-terra-high": 0,
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
          "deepseek-flash-high": 0,
          "gpt-6.1-terra-high": 0,
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
        percents: {
          "gpt-6-luna-high": 100,
          "deepseek-v4.1-flash": 0,
          "deepseek-flash-high": 0,
        },
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
    "official-flash",
    [
      "playbook: /tmp/f",
      "runtime: pi",
      "model:",
      "  provider: deepseek",
      "  id: deepseek-flash",
      "  thinking: high",
      "",
    ].join("\n"),
  );
  await writeProfile(
    profiles,
    "terra",
    [
      "playbook: /tmp/t",
      "runtime: pi",
      "model:",
      "  provider: openai-codex",
      "  id: gpt-6.1-terra",
      "  thinking: high",
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
      "  id: deepseek-chat",
      "",
    ].join("\n"),
  );

  const response = await listModelAllocations(profiles);
  assert.equal(response.appliesOnRestart, true);
  const hotList = await listModelAllocations(profiles, {
    hotReloadEnabled: true,
  });
  assert.equal(hotList.appliesOnRestart, false);
  assert.equal(response.choices.length, 4);
  assert.ok(
    response.choices.some((choice) => choice.key === "deepseek-flash-high"),
  );
  assert.ok(
    response.choices.some((choice) => choice.key === "gpt-6.1-terra-high"),
  );

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
  assert.equal(
    pinned.allocations.find((a) => a.key === "deepseek-flash-high")?.percent,
    0,
  );
  assert.equal(
    pinned.allocations.find((a) => a.key === "gpt-6.1-terra-high")?.percent,
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
  assert.equal(
    pool.allocations.find((a) => a.key === "deepseek-flash-high")?.percent,
    0,
  );
  assert.equal(
    pool.allocations.find((a) => a.key === "gpt-6.1-terra-high")?.percent,
    0,
  );

  const official = response.profiles.find(
    (row) => row.profileId === "official-flash",
  );
  assert.ok(official);
  assert.equal(official.mode, "single");
  assert.equal(official.mapped, true);
  assert.equal(
    official.allocations.find((a) => a.key === "deepseek-flash-high")?.percent,
    100,
  );

  const terra = response.profiles.find((row) => row.profileId === "terra");
  assert.ok(terra);
  assert.equal(terra.mode, "single");
  assert.equal(terra.mapped, true);
  assert.equal(
    terra.allocations.find((a) => a.key === "gpt-6.1-terra-high")?.percent,
    100,
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
      "deepseek-flash-high": 0,
      "gpt-6.1-terra-high": 0,
    },
  });
  // No reload hook → legacy restart semantics.
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
      "deepseek-flash-high": 0,
      "gpt-6.1-terra-high": 0,
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

  const official = await putModelAllocation(profiles, "alert-manager", {
    percents: {
      "gpt-6-luna-high": 0,
      "deepseek-v4.1-flash": 0,
      "deepseek-flash-high": 100,
      "gpt-6.1-terra-high": 0,
    },
  });
  assert.equal(official.profile.mode, "single");
  assert.equal(official.profile.modelPool, null);
  assert.deepEqual(official.profile.model, {
    provider: "deepseek",
    id: "deepseek-flash",
    thinking: "high",
  });
  const yamlOfficial = await readFile(
    join(profiles, "alert-manager", "profile.yaml"),
    "utf8",
  );
  assert.doesNotMatch(yamlOfficial, /model_pool:/);
  assert.match(yamlOfficial, /provider: deepseek/);
  assert.match(yamlOfficial, /id: deepseek-flash/);
  assert.match(yamlOfficial, /thinking: high/);

  const terra = await putModelAllocation(profiles, "alert-manager", {
    percents: {
      "gpt-6-luna-high": 0,
      "deepseek-v4.1-flash": 0,
      "deepseek-flash-high": 0,
      "gpt-6.1-terra-high": 100,
    },
  });
  assert.equal(terra.profile.mode, "single");
  assert.equal(terra.profile.modelPool, null);
  assert.deepEqual(terra.profile.model, {
    provider: "openai-codex",
    id: "gpt-6.1-terra",
    thinking: "high",
  });
  const yamlTerra = await readFile(
    join(profiles, "alert-manager", "profile.yaml"),
    "utf8",
  );
  assert.doesNotMatch(yamlTerra, /model_pool:/);
  assert.match(yamlTerra, /provider: openai-codex/);
  assert.match(yamlTerra, /id: gpt-6\.1-terra/);
  assert.match(yamlTerra, /thinking: high/);
  assert.match(yamlTerra, /chat_id: oc_admin/);
});

test("putModelAllocation hot-reloads in-memory Profile without restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-hot-"));
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
      "",
    ].join("\n"),
  );

  // Simulate the live serve Profile held by RunOrchestrator.
  const liveProfile: Profile = {
    id: "alert-manager",
    directory: join(profiles, "alert-manager"),
    persona: "p",
    task: "t",
    playbook: "/tmp/a",
    runtime: "pi",
    model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    schedules: [],
  };

  assert.deepEqual(selectProfileModel(liveProfile), {
    provider: "opencode-go",
    id: "deepseek-v4.1-flash",
  });

  const result = await putModelAllocation(
    profiles,
    "alert-manager",
    {
      percents: {
        "gpt-6-luna-high": 50,
        "deepseek-v4.1-flash": 50,
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 0,
      },
    },
    {
      reloadProfileModel: async (profileId) => {
        assert.equal(profileId, "alert-manager");
        const detail = (await listModelAllocations(profiles)).profiles.find(
          (row) => row.profileId === profileId,
        );
        assert.ok(detail);
        patchProfileModelFields(
          liveProfile,
          detail.model,
          detail.modelPool ?? undefined,
        );
        return true;
      },
    },
  );

  assert.equal(result.appliesOnRestart, false);
  assert.equal(result.profile.mode, "pool");
  assert.ok(liveProfile.modelPool);
  assert.equal(liveProfile.modelPool.length, 2);

  // Deterministic draws: sample 0 → first pool entry (luna 50).
  assert.deepEqual(selectProfileModel(liveProfile, { random: () => 0 }), {
    provider: "openai-codex",
    id: "gpt-6-luna",
    thinking: "high",
  });
  // sample just under 1 → second entry (deepseek 50).
  assert.deepEqual(selectProfileModel(liveProfile, { random: () => 0.999 }), {
    provider: "opencode-go",
    id: "deepseek-v4.1-flash",
  });

  const pinned = await putModelAllocation(
    profiles,
    "alert-manager",
    {
      percents: {
        "gpt-6-luna-high": 0,
        "deepseek-v4.1-flash": 0,
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 100,
      },
    },
    {
      reloadProfileModel: async () => {
        patchProfileModelFields(
          liveProfile,
          {
            provider: "openai-codex",
            id: "gpt-6.1-terra",
            thinking: "high",
          },
          undefined,
        );
        return true;
      },
    },
  );
  assert.equal(pinned.appliesOnRestart, false);
  assert.equal(liveProfile.modelPool, undefined);
  assert.deepEqual(selectProfileModel(liveProfile), {
    provider: "openai-codex",
    id: "gpt-6.1-terra",
    thinking: "high",
  });

  const failedReload = await putModelAllocation(
    profiles,
    "alert-manager",
    {
      percents: {
        "gpt-6-luna-high": 100,
        "deepseek-v4.1-flash": 0,
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 0,
      },
    },
    {
      reloadProfileModel: async () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(failedReload.appliesOnRestart, true);

  const noPatch = await putModelAllocation(
    profiles,
    "alert-manager",
    {
      percents: {
        "gpt-6-luna-high": 0,
        "deepseek-v4.1-flash": 100,
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 0,
      },
    },
    {
      reloadProfileModel: async () => false,
    },
  );
  assert.equal(noPatch.appliesOnRestart, true);
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
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 0,
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

test("model-choices.yaml extends GET choices and PUT keys; unknown disk → mapped=false", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-cfg-"));
  const profiles = join(root, "profiles");
  const choicesPath = join(root, "model-choices.yaml");
  await writeFile(
    choicesPath,
    [
      "version: 1",
      "choices:",
      "  - key: deepseek-v4.1-flash",
      "    provider: opencode-go",
      "    id: deepseek-v4.1-flash",
      "  - key: custom-kimi",
      "    provider: moonshot",
      "    id: kimi-k2",
      "    thinking: high",
      "",
    ].join("\n"),
  );
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
  await writeProfile(
    profiles,
    "orphan",
    [
      "playbook: /tmp/o",
      "runtime: pi",
      "model:",
      "  provider: openai-codex",
      "  id: gpt-6-luna",
      "  thinking: high",
      "",
    ].join("\n"),
  );

  const listed = await listModelAllocations(profiles, {
    modelChoicesPath: choicesPath,
  });
  assert.deepEqual(
    listed.choices.map((choice) => choice.key),
    ["deepseek-v4.1-flash", "custom-kimi"],
  );
  assert.equal(
    listed.choices.find((choice) => choice.key === "custom-kimi")?.label,
    "moonshot / kimi-k2 / high",
  );
  const alpha = listed.profiles.find((row) => row.profileId === "alpha");
  assert.ok(alpha);
  assert.equal(alpha.mapped, true);
  const orphan = listed.profiles.find((row) => row.profileId === "orphan");
  assert.ok(orphan);
  assert.equal(orphan.mapped, false);

  const put = await putModelAllocation(
    profiles,
    "alpha",
    {
      percents: {
        "deepseek-v4.1-flash": 40,
        "custom-kimi": 60,
      },
    },
    { modelChoicesPath: choicesPath },
  );
  assert.equal(put.profile.mode, "pool");
  assert.equal(put.profile.mapped, true);
  assert.deepEqual(put.profile.model, {
    provider: "moonshot",
    id: "kimi-k2",
    thinking: "high",
  });

  await assert.rejects(
    putModelAllocation(
      profiles,
      "alpha",
      {
        percents: {
          "deepseek-v4.1-flash": 100,
          "custom-kimi": 0,
          "gpt-6-luna-high": 0,
        },
      },
      { modelChoicesPath: choicesPath },
    ),
    (error: unknown) =>
      error instanceof ModelAllocationError &&
      /Unknown model key/.test(error.message),
  );

  // Drop custom-kimi from config → PUT must cover only remaining keys;
  // disk pool with kimi stays mapped=false.
  await writeFile(
    choicesPath,
    [
      "version: 1",
      "choices:",
      "  - key: deepseek-v4.1-flash",
      "    provider: opencode-go",
      "    id: deepseek-v4.1-flash",
      "",
    ].join("\n"),
  );
  const afterDrop = await listModelAllocations(profiles, {
    modelChoicesPath: choicesPath,
  });
  const alphaAfter = afterDrop.profiles.find(
    (row) => row.profileId === "alpha",
  );
  assert.ok(alphaAfter);
  assert.equal(alphaAfter.mapped, false);
  assert.equal(afterDrop.choices.length, 1);

  await assert.rejects(
    putModelAllocation(
      profiles,
      "alpha",
      {
        percents: {
          "deepseek-v4.1-flash": 0,
          "custom-kimi": 100,
        },
      },
      { modelChoicesPath: choicesPath },
    ),
    (error: unknown) =>
      error instanceof ModelAllocationError &&
      /Unknown model key/.test(error.message),
  );
});

test("missing model-choices.yaml keeps built-in four-item whitelist", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-nofile-"));
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
  const listed = await listModelAllocations(profiles, {
    modelChoicesPath: join(root, "model-choices.yaml"),
  });
  assert.deepEqual(
    listed.choices.map((choice) => choice.key),
    DASHBOARD_MODEL_CHOICES.map((choice) => choice.key),
  );
});

test("listModelAllocations annotates ready from pi auth probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-ready-"));
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
  const listed = await listModelAllocations(profiles, {
    choices: [
      {
        key: "deepseek-v4.1-flash",
        label: "opencode-go / deepseek-v4.1-flash",
        provider: "opencode-go",
        id: "deepseek-v4.1-flash",
      },
      {
        key: "missing-model",
        label: "nowhere / ghost",
        provider: "nowhere",
        id: "ghost",
      },
    ],
    checkAuthReady: async (target) =>
      target.provider === "opencode-go"
        ? { ready: true, conclusive: true, status: "ready" }
        : {
            ready: false,
            conclusive: true,
            status: "not_ready",
            reason: "credentials_not_configured",
          },
  });
  assert.equal(
    listed.choices.find((choice) => choice.key === "deepseek-v4.1-flash")
      ?.ready,
    true,
  );
  assert.equal(
    listed.choices.find((choice) => choice.key === "missing-model")?.ready,
    false,
  );
});

test("listModelAllocations fail-opens ready when probe is inconclusive", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-open-"));
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
  const listed = await listModelAllocations(profiles, {
    choices: [
      {
        key: "deepseek-v4.1-flash",
        label: "opencode-go / deepseek-v4.1-flash",
        provider: "opencode-go",
        id: "deepseek-v4.1-flash",
      },
    ],
    checkAuthReady: async () => ({ ready: false, conclusive: false }),
  });
  assert.equal(listed.choices[0]?.ready, true);
});

test("putModelAllocation rejects conclusively not-ready models by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-alloc-reject-"));
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
  const choices = [
    {
      key: "deepseek-v4.1-flash",
      label: "opencode-go / deepseek-v4.1-flash",
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    },
    {
      key: "ghost",
      label: "nowhere / ghost",
      provider: "nowhere",
      id: "ghost",
    },
  ] as const;
  const checkAuthReady = async (target: { provider: string; id: string }) =>
    target.provider === "opencode-go"
      ? {
          ready: true as const,
          conclusive: true as const,
          status: "ready" as const,
        }
      : {
          ready: false as const,
          conclusive: true as const,
          status: "not_ready" as const,
          reason: "credentials_not_configured",
        };

  await assert.rejects(
    putModelAllocation(
      profiles,
      "alpha",
      { percents: { "deepseek-v4.1-flash": 0, ghost: 100 } },
      { choices, checkAuthReady },
    ),
    (error: unknown) =>
      error instanceof ModelAllocationError &&
      error.status === 400 &&
      /not ready via pi auth check/.test(error.message),
  );

  const allowed = await putModelAllocation(
    profiles,
    "alpha",
    { percents: { "deepseek-v4.1-flash": 100, ghost: 0 } },
    { choices, checkAuthReady },
  );
  assert.equal(allowed.profile.mapped, true);
  assert.equal(allowed.profile.mode, "single");

  // Switch off rejection → not-ready may be written.
  const forced = await putModelAllocation(
    profiles,
    "alpha",
    { percents: { "deepseek-v4.1-flash": 0, ghost: 100 } },
    { choices, checkAuthReady, rejectUnreadyModels: false },
  );
  assert.equal(forced.profile.model.provider, "nowhere");
  assert.equal(forced.profile.model.id, "ghost");
});

test("putModelAllocation does not reject inconclusive auth probes", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "beacon-model-alloc-inconclusive-"),
  );
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
  const result = await putModelAllocation(
    profiles,
    "alpha",
    {
      percents: {
        "gpt-6-luna-high": 100,
        "deepseek-v4.1-flash": 0,
        "deepseek-flash-high": 0,
        "gpt-6.1-terra-high": 0,
      },
    },
    {
      checkAuthReady: async () => ({ ready: false, conclusive: false }),
    },
  );
  assert.equal(result.profile.model.id, "gpt-6-luna");
});
