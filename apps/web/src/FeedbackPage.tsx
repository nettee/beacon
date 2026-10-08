import type { RunRow } from "@nettee/beacon-shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CopyFeedbackButton, formatFeedbackCopy } from "./feedbackCopy";
import { Layout } from "./Layout";
import { usePathname } from "./routing";

const none = "(none)";

export type FeedbackPriority = "high" | "medium" | "low";
export type FeedbackSort = "time" | "priority";

const PRIORITIES: FeedbackPriority[] = ["high", "medium", "low"];

const PRIORITY_RANK: Record<FeedbackPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

type FeedbackItem = {
  id: string;
  priority: FeedbackPriority;
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

function flattenFeedback(rows: RunRow[]): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const run of rows) {
    const runKey = run.runId ?? `${run.profileId}-${run.acceptedAt}`;
    for (const [index, item] of (run.feedback ?? []).entries()) {
      items.push({
        id: `instruction:${runKey}:${String(index)}`,
        priority: item.priority,
        summary: item.summary,
        run,
      });
    }
  }
  return items;
}

function togglePriority(
  selected: FeedbackPriority[],
  value: FeedbackPriority,
): FeedbackPriority[] {
  if (selected.includes(value)) {
    return selected.filter((item) => item !== value);
  }
  return [...selected, value];
}

export function FeedbackPage() {
  const pathname = usePathname();
  const [rows, setRows] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [priorities, setPriorities] = useState<FeedbackPriority[]>([]);
  const [sort, setSort] = useState<FeedbackSort>("time");
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

  const allItems = useMemo(() => flattenFeedback(rows), [rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = allItems.filter((item) => {
      if (priorities.length > 0 && !priorities.includes(item.priority)) {
        return false;
      }
      if (!needle) return true;
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

    return matched.sort((left, right) => {
      if (sort === "priority") {
        const rank =
          PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
        if (rank !== 0) return rank;
      }
      return right.run.acceptedAt.localeCompare(left.run.acceptedAt);
    });
  }, [allItems, priorities, query, sort]);

  const subtitle = `${String(filtered.length)} of ${String(allItems.length)} instruction feedback`;

  return (
    <Layout
      title="Feedback"
      subtitle={subtitle}
      pathname={pathname}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="m-0 inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5">
            <legend className="sr-only">Priority filter</legend>
            {PRIORITIES.map((priority) => {
              const active =
                priorities.length === 0 || priorities.includes(priority);
              const selected = priorities.includes(priority);
              return (
                <button
                  key={priority}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setPriorities((current) =>
                      togglePriority(current, priority),
                    )
                  }
                  className={`rounded-md px-2.5 py-1.5 text-xs font-semibold tracking-wide uppercase ${
                    selected
                      ? priorityClass(priority)
                      : active
                        ? "text-zinc-600 hover:text-zinc-900"
                        : "text-zinc-400"
                  }`}
                >
                  {priority}
                </button>
              );
            })}
            {priorities.length > 0 ? (
              <button
                type="button"
                onClick={() => setPriorities([])}
                className="rounded-md px-2 py-1.5 text-xs text-sky-700 hover:text-sky-900"
              >
                Clear
              </button>
            ) : null}
          </fieldset>
          <fieldset className="m-0 inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5">
            <legend className="sr-only">Sort feedback</legend>
            <button
              type="button"
              aria-pressed={sort === "time"}
              onClick={() => setSort("time")}
              className={`rounded-md px-3 py-1.5 text-sm ${
                sort === "time"
                  ? "bg-white font-medium text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              Time
            </button>
            <button
              type="button"
              aria-pressed={sort === "priority"}
              onClick={() => setSort("priority")}
              className={`rounded-md px-3 py-1.5 text-sm ${
                sort === "priority"
                  ? "bg-white font-medium text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              Priority
            </button>
          </fieldset>
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
            const copyText = formatFeedbackCopy(
              {
                priority: item.priority,
                summary: item.summary,
                kindLabel: "指令",
                profileId: run.profileId,
                runId: run.runId,
                acceptedAt: run.acceptedAt,
              },
              formatTime,
            );
            return (
              <li key={item.id}>
                <div className="flex w-full items-start gap-3 px-1 py-3">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={
                      open ? "Collapse run details" : "Expand run details"
                    }
                    onClick={() => setExpanded(open ? null : item.id)}
                    className="mt-0.5 shrink-0 rounded px-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                  >
                    {open ? "▾" : "▸"}
                  </button>
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide uppercase ${priorityClass(item.priority)}`}
                  >
                    {item.priority}
                  </span>
                  <div className="min-w-0 flex-1 select-text">
                    <p className="text-sm text-zinc-900">{item.summary}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {run.profileId} · {formatTime(run.acceptedAt)}
                      {run.runId ? ` · ${run.runId}` : ""}
                    </p>
                  </div>
                  <CopyFeedbackButton text={copyText} className="mt-0.5" />
                </div>
                {open ? (
                  <div className="border-t border-zinc-100 bg-zinc-50/80 px-1 py-3 pl-8">
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
            No instruction feedback matches the current filters.
          </p>
        ) : null}
      </div>
    </Layout>
  );
}
