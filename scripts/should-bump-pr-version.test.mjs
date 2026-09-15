import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateBumpRequirement,
  isCliChange,
  normalizeRepoPath,
} from "./should-bump-pr-version.mjs";

test("recognizes CLI release paths", () => {
  assert.equal(normalizeRepoPath(".\\src\\cli.ts"), "src/cli.ts");
  assert.equal(isCliChange("src/runtime/pi-rpc.ts"), true);
  assert.equal(isCliChange("src/runtime/pi-rpc.test.ts"), false);
  assert.equal(isCliChange("package.json"), true);
  assert.equal(isCliChange("pnpm-lock.yaml"), true);
  assert.equal(isCliChange("tsconfig.json"), true);
  assert.equal(isCliChange("README.md"), false);
  assert.equal(isCliChange("src-not-cli/example.ts"), false);
});

test("requires a patch bump for CLI changes with an unchanged version", () => {
  assert.deepEqual(
    evaluateBumpRequirement({
      changedFiles: ["src/cli.ts", "README.md"],
      baseVersion: "0.1.1",
      headVersion: "0.1.1",
    }),
    {
      shouldBump: true,
      reason: "CLI release changes detected with unchanged package version.",
      matchedFiles: ["src/cli.ts"],
    },
  );
});

test("honors a version chosen by the PR author", () => {
  const result = evaluateBumpRequirement({
    changedFiles: ["src/cli.ts", "package.json"],
    baseVersion: "0.1.1",
    headVersion: "0.2.0",
  });
  assert.equal(result.shouldBump, false);
  assert.equal(result.reason, "PR already changes package.json version.");
});

test("does not bump documentation and test-only changes", () => {
  const result = evaluateBumpRequirement({
    changedFiles: ["README.md", "src/cli.test.ts"],
    baseVersion: "0.1.1",
    headVersion: "0.1.1",
  });
  assert.equal(result.shouldBump, false);
  assert.deepEqual(result.matchedFiles, []);
});
