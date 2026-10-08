import type { RunRow } from "@nettee/beacon-shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Layout } from "./Layout";
import { replaceLocation, usePathname, useSearchParams } from "./routing";

const none = "(none)";

export type FeedbackKind = "instruction" | "observability";

type FeedbackItem = {
  id: string;
  kind: FeedbackKind;
  priority: "high" | "medium" | "low";
  summary: string;
  run: RunRow;
};

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

function stateClass(state: string | null): string {
  if (state === "failed") return "font-semibold text-red-600";
  if (state === "running" || state === "starting" || state === "queued") {
    return "font-semibold text-amber-600";
  }
  if (state === "succeeded") return "text-emerald-700";
  return "text-zinc-600";
}

function priorityClass(priority: string): string {
  if (priority === "high") return "bg-red-100 text-red-800";
  if (priority === "medium") return "bg-amber-100 text-amber-800";
  return "bg-zinc-200 text-zinc-700";
}

function parseKind(search: string): FeedbackKind {
  const type = new URLSearchParams(search).get("type");
  return type === "observability" ? "observability" : "instruction";
}

function flattenFeedback(rows: RunRow[]): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const run of rows) {
    const runKey = run.runId ?? `${run.profileId}-${run.acceptedAt}`;
    for (const [index, item] of (run.feedback ?? []).entries()) {
      items.push({
        id: `instruction:${runKey}:${String(index)}`,
        kind: "instruction",
        priority: item.priority,
        summary: item.summary,
        run,
      });
    }
    for (const [index, item] of (run.observabilityFeedback ?? []).entries()) {
      items.push({
        id: `observability:${runKey}:${String(index)}`,
        kind: "observability",
        priority: item.priority,
        summary: item.summary,
        run,
      });
    }
  }
  return items.sort((left, right) =>
    right.run.acceptedAt.localeCompare(left.run.acceptedAt),
  );
}

function setTypeInUrl(kind: FeedbackKind): void {
  const url = new URL(window.location.href);
  if (kind === "instruction") {
    url.searchParams.delete("type");
  } else {
    url.searchParams.set("type", kind);
  }
  replaceLocation(`${url.pathname}${url.search}${url.hash}`);
}

export function FeedbackPage() {
  const pathname = usePathname();
  const search = useSearchParams();
  const kind = parseKind(search);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body: unknown = await response.json();
      const runs =
        typeof body === "object" &&
        body !== null &&
        "runs" in body &&
        Array.isArray(body.runs)
          ? (body.runs as RunRow[])
          : [];
      setRows(runs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectKind = (next: FeedbackKind) => {
    setExpanded(null);
    setTypeInUrl(next);
  };

  const allItems = useMemo(() => flattenFeedback(rows), [rows]);
  const kindItems = useMemo(
    () => allItems.filter((item) => item.kind === kind),
    [allItems, kind],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return kindItems;
    return kindItems.filter((item) => {
      const haystack = [
        item.summary,
        item.priority,
        item.run.profileId,
        item.run.kindLabel,
        item.run.runId,
        item.run.state,
        item.run.failureCode,
        item.run.acceptedAt,
        formatTime(item.run.acceptedAt),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [kindItems, query]);

  const instructionCount = allItems.filter(
    (item) => item.kind === "instruction",
  ).length;
  const observabilityCount = allItems.filter(
    (item) => item.kind === "observability",
  ).length;

  const kindLabel = kind === "instruction" ? "指令" : "可观测性";
  const subtitle = `${String(filtered.length)} of ${String(kindItems.length)} ${kindLabel} feedback · switch type in the header`;

  return (
    <Layout
      title="Feedback"
      subtitle={subtitle}
      pathname={pathname}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5"
            role="tablist"
            aria-label="Feedback type"
          >
            <button
              type="button"
              role="tab"
              aria-selected={kind === "instruction"}
              onClick={() => selectKind("instruction")}
              className={`rounded-md px-3 py-1.5 text-sm ${
                kind === "instruction"
                  ? "bg-white font-medium text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              指令 ({instructionCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kind === "observability"}
              onClick={() => selectKind("observability")}
              className={`rounded-md px-3 py-1.5 text-sm ${
                kind === "observability"
                  ? "bg-white font-medium text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              可观测性 ({observabilityCount})
            </button>
          </div>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search summary, run…"
            className="w-56 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-sky-500/40 placeholder:text-zinc-400 focus:ring-2"
          />
        </div>
      }
    >
      {error ? <p className="px-6 py-4 text-sm text-red-600">{error}</p> : null}
      {loading && rows.length === 0 ? (
        <p className="px-6 py-4 text-sm text-zinc-500">Loading feedback…</p>
      ) : null}

      <div className="px-6 py-4">
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
          {filtered.map((item) => {
            const open = expanded === item.id;
            const run = item.run;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : item.id)}
                  className="flex w-full items-start gap-3 px-1 py-3 text-left hover:bg-white"
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide uppercase ${priorityClass(item.priority)}`}
                  >
                    {item.priority}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-zinc-900">
                      {item.summary}
                    </span>
                    <span className="mt-1 block text-xs text-zinc-500">
                      {run.profileId} · {formatTime(run.acceptedAt)}
                      {run.runId ? ` · ${run.runId}` : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 shrink-0 text-xs text-zinc-400">
                    {open ? "▾" : "▸"}
                  </span>
                </button>
                {open ? (
                  <div className="border-t border-zinc-100 bg-zinc-50/80 px-1 py-3">
                    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <div>
                        <dt className="text-xs text-zinc-500">Profile</dt>
                        <dd className="mt-1 font-medium">{run.profileId}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">Time (CST)</dt>
                        <dd className="mt-1 font-mono text-xs text-zinc-700">
                          {formatTime(run.acceptedAt)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">Kind</dt>
                        <dd className="mt-1 font-mono text-xs text-zinc-700">
                          {run.kindLabel}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">Run</dt>
                        <dd className="mt-1 font-mono text-xs text-zinc-500">
                          {run.runId ?? none}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">State</dt>
                        <dd className={`mt-1 ${stateClass(run.state)}`}>
                          {run.state ?? none}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-zinc-500">Failure</dt>
                        <dd className="mt-1 font-mono text-xs text-zinc-500">
                          {run.failureCode ?? none}
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-4 text-sm">
                      {run.runId && run.hasSessionFile ? (
                        <a
                          href={`/runs/${encodeURIComponent(run.runId)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-700 hover:text-sky-900"
                        >
                          Open Pi HTML →
                        </a>
                      ) : (
                        <span className="text-zinc-400">No Pi HTML</span>
                      )}
                      <a
                        href={`/runs?profile=${encodeURIComponent(run.profileId)}`}
                        className="text-sky-700 hover:text-sky-900"
                      >
                        View profile runs →
                      </a>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {filtered.length === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            No {kindLabel} feedback matches the current filters.
          </p>
        ) : null}
      </div>
    </Layout>
  );
}
