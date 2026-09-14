import { createRequire } from "node:module";

type PackageMetadata = { version?: unknown };

const metadata = createRequire(import.meta.url)("../package.json") as unknown;
const version =
  typeof metadata === "object" && metadata !== null
    ? (metadata as PackageMetadata).version
    : undefined;

if (typeof version !== "string" || !version) {
  throw new Error("Beacon package metadata must contain a version");
}

export const packageVersion = version;
