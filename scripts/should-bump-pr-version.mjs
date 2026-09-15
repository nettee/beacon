#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH_PREFIXES = ["src/"];
const CLI_EXACT_PATHS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

export function normalizeRepoPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isCliChange(filePath) {
  const normalizedPath = normalizeRepoPath(filePath);
  const isProductionSource =
    normalizedPath.startsWith("src/") && !normalizedPath.endsWith(".test.ts");
  return (
    CLI_EXACT_PATHS.has(normalizedPath) ||
    (isProductionSource &&
      CLI_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix)))
  );
}

export function evaluateBumpRequirement({
  changedFiles,
  baseVersion,
  headVersion,
}) {
  if (!Array.isArray(changedFiles)) {
    throw new Error("changedFiles must be an array");
  }
  if (typeof baseVersion !== "string" || !baseVersion) {
    throw new Error("baseVersion is required");
  }
  if (typeof headVersion !== "string" || !headVersion) {
    throw new Error("headVersion is required");
  }

  const matchedFiles = changedFiles.map(normalizeRepoPath).filter(isCliChange);
  if (matchedFiles.length === 0) {
    return {
      shouldBump: false,
      reason: "No CLI release changes detected.",
      matchedFiles,
    };
  }
  if (baseVersion !== headVersion) {
    return {
      shouldBump: false,
      reason: "PR already changes package.json version.",
      matchedFiles,
    };
  }
  return {
    shouldBump: true,
    reason: "CLI release changes detected with unchanged package version.",
    matchedFiles,
  };
}

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function readVersion(packageJsonContent, label) {
  const metadata = JSON.parse(packageJsonContent);
  if (typeof metadata.version !== "string" || !metadata.version) {
    throw new Error(`Missing version in ${label} package.json`);
  }
  return metadata.version;
}

function writeOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    [
      `should_bump=${result.shouldBump ? "true" : "false"}`,
      `reason=${result.reason}`,
      `matched_files=${JSON.stringify(result.matchedFiles)}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const baseRef = process.argv[2];
  const headRef = process.argv[3] ?? "HEAD";
  if (!baseRef || process.argv.length > 4) {
    throw new Error(
      "Usage: node scripts/should-bump-pr-version.mjs <base-ref> [head-ref]",
    );
  }

  const changedFilesOutput = runGit([
    "diff",
    "--name-only",
    `${baseRef}...${headRef}`,
  ]);
  const changedFiles = changedFilesOutput ? changedFilesOutput.split("\n") : [];
  const baseVersion = readVersion(
    runGit(["show", `${baseRef}:package.json`]),
    "base",
  );
  const headVersion = readVersion(
    readFileSync(resolve("package.json"), "utf8"),
    "head",
  );
  const result = evaluateBumpRequirement({
    changedFiles,
    baseVersion,
    headVersion,
  });

  writeOutputs(result);
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
