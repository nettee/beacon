import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function inside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || !relativePath.startsWith("..");
}

export async function sendStaticFile(
  _request: IncomingMessage,
  response: ServerResponse,
  root: string,
  urlPath: string,
): Promise<boolean> {
  const decoded = decodeURIComponent(
    (urlPath.split("?")[0] ?? "").replaceAll("\\", "/"),
  );
  const relativePath =
    decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  if (relativePath === "" || relativePath.includes("\0")) return false;
  const candidate = resolve(root, relativePath);
  if (!inside(resolve(root), candidate)) return false;
  let metadata: Stats;
  try {
    metadata = await stat(candidate);
  } catch {
    return false;
  }
  const filePath = metadata.isDirectory()
    ? join(candidate, "index.html")
    : candidate;
  try {
    metadata = await stat(filePath);
  } catch {
    return false;
  }
  if (!metadata.isFile()) return false;
  const contentType =
    types.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
  const immutable = filePath.includes(`${sep}assets${sep}`);
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(metadata.size),
  });
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(filePath)
      .on("error", reject)
      .on("end", () => resolvePromise())
      .pipe(response);
  });
  return true;
}
