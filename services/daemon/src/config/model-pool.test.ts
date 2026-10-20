import assert from "node:assert/strict";
import test from "node:test";

import { selectProfileModel } from "./model-pool.js";

test("selectProfileModel returns model when pool is absent", () => {
  assert.deepEqual(
    selectProfileModel({
      model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    }),
    { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  );
});

test("selectProfileModel returns model when pool is empty", () => {
  assert.deepEqual(
    selectProfileModel({
      model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      modelPool: [],
    }),
    { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  );
});

test("selectProfileModel picks by weight with injected random", () => {
  const profile = {
    model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    modelPool: [
      {
        provider: "opencode-go",
        id: "deepseek-v4.1-flash",
        weight: 50,
      },
      {
        provider: "openai-codex",
        id: "gpt-6-luna",
        thinking: "high" as const,
        weight: 50,
      },
    ],
  };

  assert.deepEqual(selectProfileModel(profile, { random: () => 0 }), {
    provider: "opencode-go",
    id: "deepseek-v4.1-flash",
  });
  assert.deepEqual(selectProfileModel(profile, { random: () => 0.499 }), {
    provider: "opencode-go",
    id: "deepseek-v4.1-flash",
  });
  assert.deepEqual(selectProfileModel(profile, { random: () => 0.5 }), {
    provider: "openai-codex",
    id: "gpt-6-luna",
    thinking: "high",
  });
  assert.deepEqual(selectProfileModel(profile, { random: () => 0.999 }), {
    provider: "openai-codex",
    id: "gpt-6-luna",
    thinking: "high",
  });
});

test("selectProfileModel rejects non-positive total weight", () => {
  assert.throws(
    () =>
      selectProfileModel({
        model: { provider: "a", id: "b" },
        modelPool: [{ provider: "a", id: "b", weight: 0 }],
      }),
    /positive finite/,
  );
});
