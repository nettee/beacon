#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, parseVersion } from "./version-utils.mjs";

export function readVersion(packageJsonPath) {
  const absolutePath = resolve(packageJsonPath);
  const metadata = JSON.parse(readFileSync(absolutePath, "utf8"));
  parseVersion(metadata.version, `version in ${absolutePath}`);
  return metadata.version;
}

export function checkVersionFreshness(baseVersion, headVersion) {
  parseVersion(baseVersion, "base version");
  parseVersion(headVersion, "head version");

  if (baseVersion === headVersion) {
    return {
      ok: true,
      status: "unchanged",
      message: `package.json version unchanged at ${headVersion}.`,
    };
  }
  if (compareVersions(headVersion, baseVersion) <= 0) {
    return {
      ok: false,
      status: "stale",
      message: `PR package.json version ${headVersion} must be greater than base version ${baseVersion}.`,
    };
  }
  return {
    ok: true,
    status: "ahead",
    message: `PR package.json version ${headVersion} is ahead of base version ${baseVersion}.`,
  };
}

function main() {
  const basePackageJsonPath = process.argv[2];
  const headPackageJsonPath = process.argv[3];
  if (!basePackageJsonPath || !headPackageJsonPath || process.argv.length > 4) {
    throw new Error(
      "Usage: node scripts/check-version-freshness.mjs <base-package-json> <head-package-json>",
    );
  }

  const result = checkVersionFreshness(
    readVersion(basePackageJsonPath),
    readVersion(headPackageJsonPath),
  );
  if (!result.ok) throw new Error(result.message);
  console.log(result.message);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
