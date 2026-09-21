import type { RunSummary } from "./records.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function kindLabel(row: RunSummary): string {
  if (row.kind === "schedule" && row.scheduleId) {
    return `schedule:${row.scheduleId}`;
  }
  return row.kind;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function renderRunListPage(rows: RunSummary[]): string {
  const body = rows
    .map((row) => {
      const state = row.state ?? "";
      const runId = row.runId ?? "";
      const htmlCell =
        runId && row.hasSessionFile
          ? `<a href="/runs/${encodeURIComponent(runId)}" target="_blank" rel="noopener">Pi HTML</a>`
          : "—";
      return `<tr data-state="${escapeHtml(state)}" data-search="${escapeHtml(
        [row.profileId, kindLabel(row), runId, state, row.failureCode ?? ""]
          .join(" ")
          .toLowerCase(),
      )}">
  <td>${escapeHtml(formatTime(row.acceptedAt))}</td>
  <td>${escapeHtml(row.profileId)}</td>
  <td>${escapeHtml(kindLabel(row))}</td>
  <td><code>${escapeHtml(runId || "—")}</code></td>
  <td class="state">${escapeHtml(state || "—")}</td>
  <td>${escapeHtml(row.failureCode ?? "—")}</td>
  <td>${htmlCell}</td>
</tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Beacon Runs</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 24px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p.meta { color: CanvasText; opacity: 0.7; margin: 0 0 16px; }
    input { font: inherit; padding: 6px 8px; min-width: min(100%, 320px); }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); text-align: left; padding: 8px 10px; vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
    code { font-size: 12px; }
    tr[data-state="failed"] td.state { color: #b42318; font-weight: 600; }
    tr[data-state="running"], tr[data-state="starting"], tr[data-state="queued"] { }
    a { color: inherit; }
  </style>
</head>
<body>
  <h1>Beacon Runs</h1>
  <p class="meta">${rows.length} records · read-only · click Pi HTML to export that session</p>
  <label>Filter <input id="filter" type="search" placeholder="profile, schedule, run id, failed…"></label>
  <table>
    <thead>
      <tr>
        <th>Time (CST)</th>
        <th>Profile</th>
        <th>Kind</th>
        <th>Run</th>
        <th>State</th>
        <th>Failure</th>
        <th>HTML</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table>
  <script>
    const input = document.getElementById("filter");
    const rows = [...document.querySelectorAll("tbody tr")];
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      for (const row of rows) {
        row.hidden = q !== "" && !row.dataset.search.includes(q);
      }
    });
  </script>
</body>
</html>
`;
}
