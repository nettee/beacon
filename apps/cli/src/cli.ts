#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBeacon,
  runDoctor,
  runManualTrigger,
  runScheduleTrigger,
  submitOutcomeFromCli,
} from "@nettee/beacon-daemon";
import { parseCli, runCli } from "./cli-app.js";
import { packageVersion } from "./version.js";

const beaconCliPath = fileURLToPath(import.meta.url);
const runtime = { beaconCliPath };

async function main(): Promise<void> {
  await runCli(parseCli(process.argv.slice(2)), {
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
    submitOutcome: submitOutcomeFromCli,
    version: packageVersion,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[beacon] fatal: ${message}`);
  process.exitCode = 1;
});
