#!/usr/bin/env node

import { parseCli, runCli } from "./cli-app.js";
import { runDoctor } from "./doctor.js";
import { runManualTrigger } from "./manual-trigger.js";
import { submitOutcomeFromCli } from "./outcome/submit.js";
import { runBeacon } from "./service.js";
import { packageVersion } from "./version.js";

async function main(): Promise<void> {
  await runCli(parseCli(process.argv.slice(2)), {
    serve: runBeacon,
    doctor: runDoctor,
    trigger: runManualTrigger,
    submitOutcome: submitOutcomeFromCli,
    version: packageVersion,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[beacon] fatal: ${message}`);
  process.exitCode = 1;
});
