#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bumpVersion } from "./version-utils.mjs";

export async function bumpPackageVersion(
  release,
  packageJsonPath = "package.json",
) {
  const absolutePath = resolve(packageJsonPath);
  const source = await readFile(absolutePath, "utf8");
  const metadata = JSON.parse(source);
  const previousVersion = metadata.version;
  const nextVersion = bumpVersion(metadata.version, release);

  metadata.version = nextVersion;
  await writeFile(absolutePath, `${JSON.stringify(metadata, null, 2)}\n`);

  return { previousVersion, nextVersion };
}

async function main() {
  const release = process.argv[2];
  if (!release || process.argv.length > 3) {
    throw new Error("Usage: pnpm bump-version <major|minor|patch>");
  }

  const { previousVersion, nextVersion } = await bumpPackageVersion(release);
  console.log(
    `Bumped @nettee/beacon from ${previousVersion} to ${nextVersion}.`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
