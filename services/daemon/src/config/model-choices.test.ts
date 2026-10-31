import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILTIN_DASHBOARD_MODEL_CHOICES,
  defaultModelChoicesPath,
  formatModelChoiceLabel,
  loadDashboardModelChoices,
  parseModelChoicesDocument,
} from "./model-choices.js";

async function writeChoices(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-choices-"));
  const path = join(root, "model-choices.yaml");
  await writeFile(path, body);
  return path;
}

test("formatModelChoiceLabel uses provider / id [/ thinking]", () => {
  assert.equal(
    formatModelChoiceLabel({
      provider: "openai-codex",
      id: "gpt-6-luna",
      thinking: "high",
    }),
    "openai-codex / gpt-6-luna / high",
  );
  assert.equal(
    formatModelChoiceLabel({
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    }),
    "opencode-go / deepseek-v4.1-flash",
  );
});

test("defaultModelChoicesPath points at ~/.beacon/model-choices.yaml", () => {
  assert.equal(
    defaultModelChoicesPath("/tmp/beacon-home"),
    "/tmp/beacon-home/model-choices.yaml",
  );
});

test("builtin choices match the previous hard-coded whitelist", () => {
  assert.deepEqual(
    BUILTIN_DASHBOARD_MODEL_CHOICES.map((choice) => ({
      key: choice.key,
      label: choice.label,
      provider: choice.provider,
      id: choice.id,
      thinking: choice.thinking,
    })),
    [
      {
        key: "gpt-6-luna-high",
        label: "openai-codex / gpt-6-luna / high",
        provider: "openai-codex",
        id: "gpt-6-luna",
        thinking: "high",
      },
      {
        key: "deepseek-v4.1-flash",
        label: "opencode-go / deepseek-v4.1-flash",
        provider: "opencode-go",
        id: "deepseek-v4.1-flash",
        thinking: undefined,
      },
      {
        key: "deepseek-flash-high",
        label: "deepseek / deepseek-flash / high",
        provider: "deepseek",
        id: "deepseek-flash",
        thinking: "high",
      },
      {
        key: "gpt-6.1-terra-high",
        label: "openai-codex / gpt-6.1-terra / high",
        provider: "openai-codex",
        id: "gpt-6.1-terra",
        thinking: "high",
      },
    ],
  );
});

test("loadDashboardModelChoices falls back when file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "beacon-model-choices-missing-"));
  const path = join(root, "model-choices.yaml");
  const loaded = await loadDashboardModelChoices(path);
  assert.equal(loaded.source, "builtin");
  assert.equal(loaded.warning, undefined);
  assert.equal(loaded.choices.length, 4);
  assert.deepEqual(loaded.choices, BUILTIN_DASHBOARD_MODEL_CHOICES);
});

test("loadDashboardModelChoices reads a custom file and derives labels", async () => {
  const path = await writeChoices(`
version: 1
choices:
  - key: custom-flash
    provider: deepseek
    id: deepseek-flash
    thinking: high
  - key: luna-high
    label: Custom Luna Label
    provider: openai-codex
    id: gpt-6-luna
    thinking: high
`);
  const loaded = await loadDashboardModelChoices(path);
  assert.equal(loaded.source, "file");
  assert.equal(loaded.warning, undefined);
  assert.deepEqual(loaded.choices, [
    {
      key: "custom-flash",
      label: "deepseek / deepseek-flash / high",
      provider: "deepseek",
      id: "deepseek-flash",
      thinking: "high",
    },
    {
      key: "luna-high",
      label: "Custom Luna Label",
      provider: "openai-codex",
      id: "gpt-6-luna",
      thinking: "high",
    },
  ]);
});

test("loadDashboardModelChoices falls back on invalid schema", async () => {
  const path = await writeChoices(`
version: 1
choices: []
`);
  const loaded = await loadDashboardModelChoices(path);
  assert.equal(loaded.source, "builtin");
  assert.match(loaded.warning ?? "", /Ignoring invalid model-choices/);
  assert.deepEqual(loaded.choices, BUILTIN_DASHBOARD_MODEL_CHOICES);
});

test("parseModelChoicesDocument rejects duplicate keys and identities", () => {
  assert.throws(
    () =>
      parseModelChoicesDocument(
        {
          version: 1,
          choices: [
            {
              key: "a",
              provider: "p",
              id: "m",
            },
            {
              key: "a",
              provider: "p2",
              id: "m2",
            },
          ],
        },
        "/tmp/x.yaml",
      ),
    /Duplicate model choice key/,
  );
  assert.throws(
    () =>
      parseModelChoicesDocument(
        {
          version: 1,
          choices: [
            {
              key: "a",
              provider: "p",
              id: "m",
              thinking: "high",
            },
            {
              key: "b",
              provider: "p",
              id: "m",
              thinking: "high",
            },
          ],
        },
        "/tmp/x.yaml",
      ),
    /Duplicate model choice provider\/id\/thinking/,
  );
});
