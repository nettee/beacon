import { cp, readFile, rm, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cli = new URL("apps/cli/", root);
const daemon = new URL("services/daemon/", root);
const cliMetadata = JSON.parse(
  await readFile(new URL("package.json", cli), "utf8"),
);
const daemonMetadata = JSON.parse(
  await readFile(new URL("package.json", daemon), "utf8"),
);
// The published CLI is self-contained: internal workspace packages stay private.
for (const [name, version] of Object.entries(
  daemonMetadata.dependencies ?? {},
)) {
  if (version.startsWith("workspace:")) continue;
  if (cliMetadata.dependencies?.[name] !== version) {
    throw new Error(
      `CLI runtime dependency ${name} must match daemon (${version})`,
    );
  }
}
for (const [source, destination] of [
  [new URL("dist/", daemon), new URL("dist/daemon/", cli)],
  [new URL("apps/web/dist/", root), new URL("dist/web/", cli)],
  [new URL("deploy/", root), new URL("deploy/", cli)],
  [new URL("examples/", root), new URL("examples/", cli)],
]) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}
for (const name of ["README.md", "LICENSE"]) {
  await cp(new URL(name, root), new URL(name, cli));
}
const entry = new URL("dist/cli.js", cli);
const source = await readFile(entry, "utf8");
if (!source.includes('"@nettee/beacon-daemon"'))
  throw new Error("Compiled CLI daemon import missing");
await writeFile(
  entry,
  source.replaceAll('"@nettee/beacon-daemon"', '"./daemon/index.js"'),
);
