#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readPackageIdentity(packageJsonPath = "package.json") {
  const absolutePath = resolve(packageJsonPath);
  const metadata = JSON.parse(readFileSync(absolutePath, "utf8"));
  if (typeof metadata.name !== "string" || !metadata.name) {
    throw new Error(`Missing package name in ${absolutePath}`);
  }
  if (typeof metadata.version !== "string" || !metadata.version) {
    throw new Error(`Missing package version in ${absolutePath}`);
  }
  return { name: metadata.name, version: metadata.version };
}

export function checkNpmVersionExists(name, version, execute = execFileSync) {
  const spec = `${name}@${version}`;
  let output;
  try {
    output = execute("npm", ["view", spec, "version", "--json"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (/\bE404\b|404 Not Found/.test(`${stdout}\n${stderr}`)) {
      return {
        exists: false,
        message: `npm does not have ${spec}; publish is required.`,
        name,
        spec,
        version,
      };
    }
    throw error;
  }

  let publishedVersion;
  try {
    publishedVersion = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm returned invalid JSON for ${spec}`, { cause: error });
  }
  if (publishedVersion !== version) {
    throw new Error(
      `npm returned unexpected version for ${spec}: ${JSON.stringify(publishedVersion)}`,
    );
  }
  return {
    exists: true,
    message: `npm already has ${spec}; skipping publish.`,
    name,
    spec,
    version,
  };
}

function writeGitHubOutput(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    [
      `exists=${result.exists ? "true" : "false"}`,
      `name=${result.name}`,
      `version=${result.version}`,
      `spec=${result.spec}`,
      `message=${result.message}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const { name, version } = readPackageIdentity(process.argv[2]);
  const result = checkNpmVersionExists(name, version);
  writeGitHubOutput(result);
  console.log(result.message);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
