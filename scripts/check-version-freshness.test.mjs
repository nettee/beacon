import assert from "node:assert/strict";
import test from "node:test";
import { checkVersionFreshness } from "./check-version-freshness.mjs";

test("accepts unchanged and newer versions", () => {
  assert.equal(checkVersionFreshness("1.2.3", "1.2.3").status, "unchanged");
  assert.equal(checkVersionFreshness("1.2.3", "1.2.4").status, "ahead");
  assert.equal(checkVersionFreshness("1.2.3", "1.3.0").status, "ahead");
  assert.equal(checkVersionFreshness("1.9.0", "1.10.0").status, "ahead");
  assert.equal(checkVersionFreshness("1.2.3", "2.0.0").status, "ahead");
});

test("rejects stale and invalid versions", () => {
  assert.equal(checkVersionFreshness("1.2.3", "1.2.2").ok, false);
  assert.equal(checkVersionFreshness("1.2.3", "0.9.0").ok, false);
  assert.throws(() => checkVersionFreshness("1.2.3", "1.2"), /expected exact/);
});
