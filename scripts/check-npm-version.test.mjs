import assert from "node:assert/strict";
import test from "node:test";

import { checkNpmVersionExists } from "./check-npm-version.mjs";

test("recognizes an existing exact npm version", () => {
  const result = checkNpmVersionExists(
    "@nettee/beacon",
    "0.1.0",
    () => '"0.1.0"\n',
  );
  assert.equal(result.exists, true);
  assert.equal(result.spec, "@nettee/beacon@0.1.0");
});

test("treats an explicit registry 404 as unpublished", () => {
  const result = checkNpmVersionExists("@nettee/beacon", "0.1.0", () => {
    throw Object.assign(new Error("not found"), {
      stderr: "npm error code E404\nnpm error 404 Not Found",
    });
  });
  assert.equal(result.exists, false);
});

test("propagates authentication and network failures", () => {
  const failure = Object.assign(new Error("unauthorized"), {
    stderr: "npm error code E401",
  });
  assert.throws(
    () =>
      checkNpmVersionExists("@nettee/beacon", "0.1.0", () => {
        throw failure;
      }),
    (error) => error === failure,
  );
});

test("rejects malformed or unexpected registry responses", () => {
  assert.throws(
    () => checkNpmVersionExists("@nettee/beacon", "0.1.0", () => "nope"),
    /invalid JSON/,
  );
  assert.throws(
    () => checkNpmVersionExists("@nettee/beacon", "0.1.0", () => '"0.2.0"'),
    /unexpected version/,
  );
});
