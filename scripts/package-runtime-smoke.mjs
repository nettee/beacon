import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Exercise packaged boundaries without contacting Feishu or a real Pi runtime. */
export async function testPackageRuntime(installedPackage, temporaryRoot) {
  const load = (path) => import(pathToFileURL(join(installedPackage, path)));
  const profiles = join(temporaryRoot, "profiles");
  const sessions = join(temporaryRoot, "sessions");
  await mkdir(profiles);
  await mkdir(sessions);
  let dashboard;
  let outcome;
  const environmentKeys = [
    "BEACON_CLI_PATH",
    "BEACON_OUTCOME_SOCKET",
    "BEACON_RUN_TOKEN",
  ];
  const previous = environmentKeys.map((key) => process.env[key]);
  const failures = [];
  try {
    const { startDashboard } = await load("dist/daemon/dashboard/server.js");
    dashboard = await startDashboard({
      uiDirectory: join(installedPackage, "dist/web"),
      profilesDirectory: profiles,
      sessionDirectory: sessions,
      piExecutable: process.execPath,
      listen: "127.0.0.1",
      port: 0,
    });
    const base = `http://127.0.0.1:${dashboard.port}`;
    for (const route of ["/", "/runs", "/profiles"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      const body = await response.text();
      assert.match(body, /<div id="root">/);
      const assets = [...body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
      assert(assets.length > 0, "web HTML must reference built assets");
      for (const [, asset] of assets) {
        const response = await fetch(base + asset);
        assert.equal(response.status, 200, asset);
        assert((await response.text()).length > 0);
      }
    }
    for (const [route, expected] of [
      ["/api/runs", { runs: [] }],
      ["/api/profiles", { profiles: [] }],
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.deepEqual(await response.json(), expected);
    }
    const { startOutcomeServer } = await load("dist/daemon/outcome/server.js");
    outcome = await startOutcomeServer();
    const submission = outcome.openRun();
    process.env.BEACON_CLI_PATH = join(installedPackage, "dist/cli.js");
    process.env.BEACON_OUTCOME_SOCKET = submission.binding.socketPath;
    process.env.BEACON_RUN_TOKEN = submission.binding.runToken;
    const { default: register } = await load(
      "dist/daemon/runtime/pi-outcome-extension.js",
    );
    const tools = new Map();
    register({
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    });
    const reply = tools.get("reply_text");
    assert(reply, "packaged Pi extension must register reply_text");
    await reply.execute(
      "package-smoke",
      { text: "packaged outcome" },
      AbortSignal.timeout(10_000),
    );
    assert.equal(submission.take().reply.text, "packaged outcome");
  } catch (error) {
    failures.push(error);
  } finally {
    for (const [index, key] of environmentKeys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    const closed = await Promise.allSettled([
      dashboard?.close(),
      outcome?.close(),
    ]);
    for (const result of closed) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Packaged runtime checks failed");
}
