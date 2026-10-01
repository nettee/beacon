import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readReleaseMetadataAtRef(ref) {
  const paths = execFileSync(
    "git",
    ["ls-tree", "--name-only", ref, "apps/cli/package.json"],
    { encoding: "utf8" },
  ).trim();
  const path = paths ? "apps/cli/package.json" : "package.json";
  return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  if (process.argv.length !== 3)
    throw new Error("Usage: node scripts/read-release-metadata.mjs <git-ref>");
  process.stdout.write(readReleaseMetadataAtRef(process.argv[2]));
}
