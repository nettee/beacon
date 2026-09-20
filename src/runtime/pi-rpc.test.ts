import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiRuntimeError, runPiAgent } from "./pi-rpc.js";

async function fakePi(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "beacon-pi-rpc-"));
  const executable = join(directory, "pi");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, {
    mode: 0o700,
  });
  await chmod(executable, 0o700);
  return executable;
}

test("returns the final assistant message after agent_settled", async () => {
  const executable = await fakePi(`
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "intermediate" }],
        provider: "test", model: "fake", stopReason: "toolUse"
      }}));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "final answer" }],
        provider: "test", model: "fake", stopReason: "stop"
      }}));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `);

  const result = await runPiAgent(
    {
      prompt: "hello",
      workspace: process.cwd(),
      provider: "test",
      model: "fake",
    },
    { executable, timeoutMs: 2_000 },
  );
  assert.deepEqual(result, {
    text: "final answer",
    provider: "test",
    model: "fake",
  });
});

test("does not require a final assistant text when Delivery uses an explicit Outcome", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [],
        provider: "test", model: "fake", stopReason: "stop"
      }}));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `);

  const result = await runPiAgent(
    {
      prompt: "hello",
      workspace: process.cwd(),
      provider: "test",
      model: "fake",
      outcome: {
        socketPath: "/tmp/beacon.sock",
        runToken: "run-token",
        cliPath: "/beacon/dist/cli.js",
      },
    },
    { executable, timeoutMs: 2_000 },
  );
  assert.deepEqual(result, { text: "", provider: "test", model: "fake" });
});

test("uses an isolated named persistent session when session metadata is provided", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({ type: "response", id: command.id, success: true }));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }],
        provider: "test", model: "fake", stopReason: "stop"
      }}));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `);
  const root = await mkdtemp(join(tmpdir(), "beacon-pi-session-"));
  const sessionPath = join(root, "profile", "run_123");
  const result = await runPiAgent(
    {
      prompt: "hello",
      workspace: process.cwd(),
      session: {
        id: "run_123",
        path: sessionPath,
        name: "Beacon profile run_123",
      },
    },
    { executable, timeoutMs: 2_000 },
  );
  const args = JSON.parse(result.text) as string[];
  assert.deepEqual(args.slice(0, 9), [
    "--mode",
    "rpc",
    "--no-approve",
    "--session-dir",
    sessionPath,
    "--session-id",
    "run_123",
    "--name",
    "Beacon profile run_123",
  ]);
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o700);
});

test("keeps diagnostics ephemeral when session metadata is omitted", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({ type: "response", id: command.id, success: true }));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }],
        provider: "test", model: "fake", stopReason: "stop"
      }}));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `);
  const result = await runPiAgent(
    { prompt: "doctor", workspace: process.cwd() },
    { executable, timeoutMs: 2_000 },
  );
  const args = JSON.parse(result.text) as string[];
  assert.ok(args.includes("--no-session"));
  assert.ok(!args.includes("--session-dir"));
  assert.ok(!args.includes("--session-id"));
});

test("rejects invalid persistent session metadata before spawning Pi", async () => {
  await assert.rejects(
    runPiAgent({
      prompt: "hello",
      workspace: process.cwd(),
      session: { id: "../escape", path: "relative" },
    }),
    /session ID is invalid/,
  );
});

test("fails when Pi reports an agent error", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "partial" }],
        provider: "test", model: "fake", stopReason: "error", errorMessage: "provider failed"
      }}));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `);

  await assert.rejects(
    runPiAgent(
      {
        prompt: "hello",
        workspace: process.cwd(),
        provider: "test",
        model: "fake",
      },
      { executable, timeoutMs: 2_000 },
    ),
    /stopReason=error: provider failed/,
  );
});

test("fails when Pi rejects the prompt command", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({
        type: "response", id: command.id, command: "prompt", success: false, error: "model unavailable"
      }));
    });
  `);

  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      { executable, timeoutMs: 2_000 },
    ),
    /Pi rejected the prompt: model unavailable/,
  );
});

test("fails on malformed RPC output", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", () => console.log("not-json"));
  `);

  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      { executable, timeoutMs: 2_000 },
    ),
    /invalid RPC JSON/,
  );
});

test("requires provider and model together", async () => {
  await assert.rejects(
    runPiAgent({
      prompt: "hello",
      workspace: process.cwd(),
      provider: "openrouter",
    }),
    /provider and model must either both be set or both be omitted/,
  );
});

test("classifies a Run timeout", async () => {
  const executable = await fakePi(`process.stdin.resume();`);
  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      { executable, timeoutMs: 25, terminateGraceMs: 10 },
    ),
    (error: unknown) =>
      error instanceof PiRuntimeError && error.code === "runtime_timeout",
  );
});

test("rejects an oversized RPC frame", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", () => console.log("x".repeat(200)));
  `);
  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      { executable, timeoutMs: 2_000, maxFrameBytes: 64 },
    ),
    (error: unknown) =>
      error instanceof PiRuntimeError &&
      error.code === "runtime_protocol_error",
  );
});

test("rejects Pi environment keys outside the allowlist", async () => {
  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      { environment: { FEISHU_APP_SECRET: "must-not-leak" } },
    ),
    /not allowlisted/,
  );
});

test("passes the loaded runtime environment to Pi", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({ type: "response", id: command.id, success: true }));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: process.env.GRAFANA_READER_TOKEN_PROD ?? "missing" }],
        provider: "test", model: "fake", stopReason: "stop"
      }}));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `);
  const result = await runPiAgent(
    { prompt: "hello", workspace: process.cwd() },
    {
      executable,
      timeoutMs: 2_000,
      runtimeEnvironment: {
        GRAFANA_READER_TOKEN_PROD: "reader-token",
      },
    },
  );
  assert.equal(result.text, "reader-token");
});

test("rejects reserved runtime environment variables", async () => {
  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      {
        environment: { PI_CODING_AGENT_DIR: "/tmp/pi" },
        runtimeEnvironment: { BEACON_RUN_TOKEN: "must-not-override" },
      },
    ),
    /reserved/,
  );
});

test("classifies an executable spawn failure", async () => {
  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      { executable: "/definitely/missing/beacon-pi", timeoutMs: 2_000 },
    ),
    (error: unknown) =>
      error instanceof PiRuntimeError && error.code === "runtime_spawn_failed",
  );
});

test("requires the authoritative assistant message before agent_settled", async () => {
  const executable = await fakePi(`
    process.stdin.once("data", (line) => {
      const command = JSON.parse(line);
      console.log(JSON.stringify({ type: "response", id: command.id, success: true }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `);
  await assert.rejects(
    runPiAgent(
      { prompt: "hello", workspace: process.cwd() },
      { executable, timeoutMs: 2_000 },
    ),
    (error: unknown) =>
      error instanceof PiRuntimeError &&
      error.code === "runtime_protocol_error",
  );
});
