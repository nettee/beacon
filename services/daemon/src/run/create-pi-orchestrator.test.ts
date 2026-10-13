import assert from "node:assert/strict";
import test from "node:test";

import { resolveProfileTimeoutSeconds } from "./create-pi-orchestrator.js";

test("resolveProfileTimeoutSeconds uses Profile override when set", () => {
  assert.equal(
    resolveProfileTimeoutSeconds({ timeoutSeconds: 5400 }, 1800),
    5400,
  );
});

test("resolveProfileTimeoutSeconds falls back to global default", () => {
  assert.equal(resolveProfileTimeoutSeconds({}, 1800), 1800);
  assert.equal(
    resolveProfileTimeoutSeconds({ timeoutSeconds: undefined }, 300),
    300,
  );
});

test("resolveProfileTimeoutSeconds allows Profile to exceed global default", () => {
  assert.equal(
    resolveProfileTimeoutSeconds({ timeoutSeconds: 7200 }, 1800),
    7200,
  );
});
