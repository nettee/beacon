#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli, runCli } from "./cli-app.js";
import { packageVersion } from "./version.js";

const beaconCliPath = fileURLToPath(import.meta.url);
const runtime = { beaconCliPath };

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));

  // Pi spawns `beacon outcome submit` for every Final Outcome. Keep that path
  // free of service/Feishu gateway imports so a partial package install cannot
  // turn an accepted `no_reply` into runtime_exit_failed (see #105).
  if (command.command === "outcome-submit") {
    const { submitOutcomeFromCli } = await import(
      "@nettee/beacon-daemon/outcome"
    );
    await submitOutcomeFromCli();
    return;
  }

  if (command.command === "version") {
    console.log(packageVersion);
    return;
  }

  const {
    runBeacon,
    runDoctor,
    runManualTrigger,
    runScheduleTrigger,
  } = await import("@nettee/beacon-daemon");

  await runCli(command, {
    serve: (config) =>
      runBeacon(config, {
        ...runtime,
        uiDirectory: join(dirname(beaconCliPath), "web"),
      }),
    doctor: runDoctor,
    trigger: (config, profile, input) =>
      runManualTrigger(config, profile, input, runtime),
    triggerSchedule: (config, profile, schedule) =>
      runScheduleTrigger(config, profile, schedule, runtime),
    submitOutcome: async () => {
      throw new Error("outcome-submit must use the light import path");
    },
    version: packageVersion,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[beacon] fatal: ${message}`);
  process.exitCode = 1;
});
