function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function systemMessageText(
  content: string,
  sections: Map<string, string>,
): string {
  return [content, ...sections.values()]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/** Prefer a JSONL system message; otherwise the Beacon-owned `--system-prompt` text. */
export function pickExportedSystemPrompt(
  jsonl: string,
  beaconOwned?: string | undefined,
): string | undefined {
  return systemPromptFromJsonl(jsonl) ?? nonempty(beaconOwned);
}

export function systemPromptFromJsonl(jsonl: string): string | undefined {
  const contents: string[] = [];
  const sections = new Map<string, string>();
  let seen = false;

  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    const message = asRecord(entry?.message);
    if (entry?.type !== "message" || message?.role !== "system") continue;
    seen = true;
    const text = contentText(message.content);
    if (text.length > 0) contents.push(text);
    const named = asRecord(message.sections);
    if (!named) continue;
    for (const [name, value] of Object.entries(named)) {
      if (value === null) sections.delete(name);
      else if (typeof value === "string") sections.set(name, value);
    }
  }

  if (!seen) return undefined;
  const prompt = systemMessageText(contents.join("\n\n"), sections);
  return prompt.length > 0 ? prompt : undefined;
}

const sessionDataScript =
  /<script\s+id="session-data"(?:\s+[^>]*)?>([A-Za-z0-9+/=\s]*)<\/script>/i;

export function fillExportedHtmlSystemPrompt(
  html: string,
  systemPrompt: string,
): string {
  if (systemPrompt.length === 0) return html;
  const match = sessionDataScript.exec(html);
  if (!match || match.index === undefined) return html;
  const raw = match[1] ?? "";
  const encoded = raw.replace(/\s+/g, "");
  if (encoded.length === 0) return html;

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    );
    const record = asRecord(parsed);
    if (!record) return html;
    data = record;
  } catch {
    return html;
  }

  const existing = data.systemPrompt;
  if (typeof existing === "string" && existing.length > 0) return html;
  data.systemPrompt = systemPrompt;
  const next = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  return (
    html.slice(0, match.index) +
    match[0].replace(raw, next) +
    html.slice(match.index + match[0].length)
  );
}
