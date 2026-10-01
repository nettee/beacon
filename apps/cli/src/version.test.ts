import assert from "node:assert/strict";
import test from "node:test";

import packageMetadata from "../package.json" with { type: "json" };
import { packageVersion } from "./version.js";

test("reports the package.json version", () => {
  assert.equal(packageVersion, packageMetadata.version);
});
