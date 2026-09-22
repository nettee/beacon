import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";

import {
  fillExportedHtmlSystemPrompt,
  systemPromptFromJsonl,
} from "./session-prompt.js";

const execFileAsync = promisify(execFile);

export type SessionExportRequest = {
  executable: string;
  sessionDirectory: string;
  runId: string;
  sessionPath: string;
  timeoutMs?: number | undefined;
};

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export async function resolveSessionJsonl(
  sessionDirectory: string,
  runId: string,
  sessionPath: string,
): Promise<string> {
  if (!isAbsolute(sessionDirectory) || !isAbsolute(sessionPath)) {
    throw new Error("Pi session paths must be absolute");
  }
  const root = await realpath(sessionDirectory);
  const canonical = await realpath(sessionPath);
  if (!isInside(root, canonical)) {
    throw new Error(
      "Pi session path is outside the configured session directory",
    );
  }
  if (basename(canonical) !== runId) {
    throw new Error("Pi session directory does not match the Run ID");
  }
  const profileDirectory = dirname(canonical);
  if (!isInside(root, profileDirectory) || profileDirectory === root) {
    throw new Error("Pi session path is not a per-Run directory");
  }
  const entries = await readdir(canonical, { withFileTypes: true });
  const jsonl = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(canonical, entry.name));
  if (jsonl.length === 0) {
    throw new Error(`No Pi session JSONL found for ${runId}`);
  }
  jsonl.sort();
  return jsonl[jsonl.length - 1]!;
}

export async function exportSessionHtml(
  request: SessionExportRequest,
): Promise<string> {
  const jsonlPath = await resolveSessionJsonl(
    request.sessionDirectory,
    request.runId,
    request.sessionPath,
  );
  const directory = await mkdtemp(join(tmpdir(), "beacon-dashboard-"));
  const outputPath = join(directory, `${request.runId}.html`);
  try {
    await execFileAsync(
      request.executable,
      ["--export", jsonlPath, outputPath],
      {
        timeout: request.timeoutMs ?? 60_000,
        windowsHide: true,
      },
    );
    const html = await readFile(outputPath, "utf8");
    const systemPrompt = systemPromptFromJsonl(
      await readFile(jsonlPath, "utf8"),
    );
    return systemPrompt
      ? fillExportedHtmlSystemPrompt(html, systemPrompt)
      : html;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
