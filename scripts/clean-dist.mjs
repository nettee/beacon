import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await rm(resolve("dist"), { force: true, recursive: true });
