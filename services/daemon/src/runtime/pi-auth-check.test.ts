import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  authIdentityKey,
  checkPiAuthReady,
  probeChoiceAuthReady,
} from "./pi-auth-check.js";

async function fakePi(
  script: string,
): Promise<{ executable: string; codingAgentDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "beacon-pi-auth-"));
  const executable = join(root, "pi");
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return { executable, codingAgentDirectory: root };
}

test("checkPiAuthReady parses ready JSON on exit 0", async () => {
  const { executable, codingAgentDirectory } = await fakePi(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ status: "ready", provider: "deepseek", authType: "api_key" }) + "\\n");
process.exit(0);
`);
  const result = await checkPiAuthReady(
    { provider: "deepseek", id: "deepseek-flash" },
    { executable, codingAgentDirectory, timeoutMs: 5_000 },
  );
  assert.deepEqual(result, {
    ready: true,
    conclusive: true,
    status: "ready",
  });
});

test("checkPiAuthReady parses not_ready JSON on exit 1", async () => {
  const { executable, codingAgentDirectory } = await fakePi(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  status: "not_ready",
  provider: "missing",
  reason: "credentials_not_configured",
}) + "\\n");
process.exit(1);
`);
  const result = await checkPiAuthReady(
    { provider: "missing", id: "x" },
    { executable, codingAgentDirectory, timeoutMs: 5_000 },
  );
  assert.deepEqual(result, {
    ready: false,
    conclusive: true,
    status: "not_ready",
    reason: "credentials_not_configured",
  });
});

test("checkPiAuthReady is inconclusive when stdout is not JSON", async () => {
  const { executable, codingAgentDirectory } = await fakePi(`#!/usr/bin/env node
process.stdout.write("not-json\\n");
process.exit(2);
`);
  const result = await checkPiAuthReady(
    { provider: "openai-codex", id: "gpt-6-luna" },
    { executable, codingAgentDirectory, timeoutMs: 5_000 },
  );
  assert.deepEqual(result, { ready: false, conclusive: false });
});

test("checkPiAuthReady sets PI_CODING_AGENT_DIR for the child", async () => {
  const { executable, codingAgentDirectory } = await fakePi(`#!/usr/bin/env node
const dir = process.env.PI_CODING_AGENT_DIR ?? "";
const ok = dir.length > 0;
process.stdout.write(JSON.stringify({
  status: ok ? "ready" : "not_ready",
  provider: "deepseek",
  reason: ok ? undefined : "credentials_not_configured",
}) + "\\n");
process.exit(ok ? 0 : 1);
`);
  const result = await checkPiAuthReady(
    { provider: "deepseek", id: "deepseek-flash" },
    { executable, codingAgentDirectory, timeoutMs: 5_000 },
  );
  assert.equal(result.ready, true);
  assert.equal(result.conclusive, true);
});

test("probeChoiceAuthReady dedupes provider+id and maps results", async () => {
  const calls: string[] = [];
  const map = await probeChoiceAuthReady(
    [
      { provider: "a", id: "m1" },
      { provider: "a", id: "m1" },
      { provider: "b", id: "m2" },
    ],
    async (target) => {
      calls.push(`${target.provider}/${target.id}`);
      return {
        ready: target.provider === "a",
        conclusive: true,
        status: target.provider === "a" ? "ready" : "not_ready",
      };
    },
  );
  assert.deepEqual(calls.sort(), ["a/m1", "b/m2"]);
  assert.equal(
    map.get(authIdentityKey({ provider: "a", id: "m1" }))?.ready,
    true,
  );
  assert.equal(
    map.get(authIdentityKey({ provider: "b", id: "m2" }))?.ready,
    false,
  );
});
