import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bumpPackageVersion } from "./bump-version.mjs";
import { bumpVersion } from "./version-utils.mjs";

test("bumps exact semantic versions", () => {
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
});

test("rejects invalid versions and release types", () => {
  assert.throws(() => bumpVersion("1.2", "patch"), /expected exact/);
  assert.throws(() => bumpVersion("1.2.3", "prerelease"), /expected major/);
});

test("updates only the package version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-version-test-"));
  const packageJsonPath = join(directory, "package.json");

  try {
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ name: "@nettee/beacon", version: "3.4.5" }, null, 2)}\n`,
    );
    const result = await bumpPackageVersion("minor", packageJsonPath);
    const metadata = JSON.parse(await readFile(packageJsonPath, "utf8"));

    assert.deepEqual(result, {
      previousVersion: "3.4.5",
      nextVersion: "3.5.0",
    });
    assert.deepEqual(metadata, { name: "@nettee/beacon", version: "3.5.0" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
