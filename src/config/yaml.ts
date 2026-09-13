import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

export async function parseStrictYaml(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read YAML configuration at ${path}`, { cause: error });
  }

  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML configuration at ${path}: ${document.errors[0]?.message}`);
  }
  if (document.warnings.length > 0) {
    throw new Error(`YAML warning at ${path}: ${document.warnings[0]?.message}`);
  }

  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`YAML aliases are not allowed at ${path}`, { cause: error });
  }
}
