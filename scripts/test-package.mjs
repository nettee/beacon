import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = new URL("..", import.meta.url);
const temporaryRoot = await mkdtemp(join(tmpdir(), "beacon-package-"));
const artifactDirectory = join(temporaryRoot, "artifact");
const installPrefix = join(temporaryRoot, "install");
const npmCache = join(temporaryRoot, "npm-cache");
const environment = { ...process.env, npm_config_cache: npmCache };
const sourceMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: environment,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}${details ? `:\n${details}` : ""}`,
    );
  }
  return result;
}

function assertPackageManifest(files) {
  const paths = files.map((file) => file.path);
  for (const required of [
    "dist/cli.js",
    "dist/runtime/pi-outcome-extension.js",
    "LICENSE",
    "package.json",
    "README.md",
  ]) {
    assert(paths.includes(required), `package is missing ${required}`);
  }

  const allowed = ["dist/", "deploy/", "examples/"];
  const allowedFiles = new Set(["LICENSE", "package.json", "README.md"]);
  for (const path of paths) {
    assert(
      allowedFiles.has(path) ||
        allowed.some((prefix) => path.startsWith(prefix)),
      `package contains unexpected path ${path}`,
    );
    assert(!path.includes(".test."), `package contains test output ${path}`);
  }
}

try {
  run("pnpm", ["build"]);
  await mkdir(artifactDirectory, { recursive: true });
  const packed = run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    artifactDirectory,
  ]);
  const packResults = JSON.parse(packed.stdout);
  assert(Array.isArray(packResults) && packResults.length === 1);
  const [packResult] = packResults;
  assertPackageManifest(packResult.files);

  const tarball = join(artifactDirectory, packResult.filename);
  run("npm", ["install", "--global", "--prefix", installPrefix, tarball]);

  const installedPackage = join(
    installPrefix,
    "lib",
    "node_modules",
    "@nettee",
    "beacon",
  );
  const installedMetadata = JSON.parse(
    await readFile(join(installedPackage, "package.json"), "utf8"),
  );
  assert.equal(installedMetadata.name, sourceMetadata.name);
  assert.equal(installedMetadata.version, sourceMetadata.version);
  await access(join(installedPackage, "dist", "cli.js"));
  await access(
    join(installedPackage, "dist", "runtime", "pi-outcome-extension.js"),
  );

  const executable = join(installPrefix, "bin", "beacon");
  const version = run(executable, ["version"], { cwd: temporaryRoot });
  assert.equal(version.stdout, `${sourceMetadata.version}\n`);

  const invalid = spawnSync(
    executable,
    ["doctor", "--config", "relative.yaml"],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: environment,
    },
  );
  if (invalid.error) throw invalid.error;
  assert.notEqual(
    invalid.status,
    0,
    "invalid CLI invocation unexpectedly passed",
  );
  assert.match(invalid.stderr, /Config path must be absolute/);

  console.log("Packaged Beacon CLI passed isolated installation checks.");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
