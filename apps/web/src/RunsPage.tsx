import type { RunRow } from "@nettee/beacon-shared";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { HeaderFilter } from "./HeaderFilter";
import { Layout } from "./Layout";
import { replaceLocation, useSearchParams } from "./routing";

const none = "(none)";

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value || none))].sort(
    (left, right) => left.localeCompare(right),
  );
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

function stateClass(state: string | null): string {
  if (state === "failed") return "font-semibold text-red-600";
  if (state === "running" || state === "starting" || state === "queued") {
    return "font-semibold text-amber-600";
  }
  if (state === "succeeded") return "text-emerald-700";
  return "text-zinc-600";
}

function profilesFromSearch(search: string): string[] {
  const params = new URLSearchParams(search);
  return params
    .getAll("profile")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function RunsPage() {
  const search = useSearchParams();
  const [rows, setRows] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState<string[]>(() =>
    profilesFromSearch(search),
  );
  const [kind, setKind] = useState<string[]>([]);
  const [state, setState] = useState<string[]>([]);
  const [failure, setFailure] = useState<string[]>([]);

  useEffect(() => {
    setProfile(profilesFromSearch(search));
  }, [search]);

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

  const onProfileChange = (next: string[]) => {
    setProfile(next);
    const url = new URL(window.location.href);
    url.searchParams.delete("profile");
    for (const value of next) {
      url.searchParams.append("profile", value);
    }
    replaceLocation(`${url.pathname}${url.search}${url.hash}`);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (profile.length > 0 && !profile.includes(row.profileId || none)) {
        return false;
      }
      if (kind.length > 0 && !kind.includes(row.kindLabel || none)) {
        return false;
      }
      if (state.length > 0 && !state.includes(row.state || none)) return false;
      if (failure.length > 0 && !failure.includes(row.failureCode || none)) {
        return false;
      }
      if (!needle) return true;
      const haystack = [
        row.profileId,
        row.kindLabel,
        row.runId,
        row.state,
        row.failureCode,
        row.acceptedAt,
        formatTime(row.acceptedAt),
        ...(row.feedback ?? []).map((item) => item.summary),
        ...(row.observabilityFeedback ?? []).map((item) => item.summary),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, profile, kind, state, failure, query]);

  const subtitleParts = [
    `${String(filtered.length)} of ${String(rows.length)} runs`,
    profile.length > 0
      ? `profile filter: ${profile.join(", ")}`
      : "header filters are multi-select",
    "Pi HTML opens in a new tab",
  ];

  return (
    <Layout
      title="Run History"
      subtitle={subtitleParts.join(" · ")}
      actions={
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search run id, time…"
          className="w-64 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-sky-500/40 placeholder:text-zinc-400 focus:ring-2"
        />
      }
    >
      {error ? <p className="px-6 py-4 text-sm text-red-600">{error}</p> : null}
      {loading && rows.length === 0 ? (
        <p className="px-6 py-4 text-sm text-zinc-500">Loading runs…</p>
      ) : null}

      <div className="overflow-x-auto px-6 py-4">
        <table className="w-full min-w-[960px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-50">
            <tr className="border-b border-zinc-200">
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Time (CST)
              </th>
              <th className="px-3 py-2">
                <HeaderFilter
                  label="Profile"
                  options={unique(rows.map((row) => row.profileId))}
                  selected={profile}
                  onChange={onProfileChange}
                />
              </th>
              <th className="px-3 py-2">
                <HeaderFilter
                  label="Kind"
                  options={unique(rows.map((row) => row.kindLabel))}
                  selected={kind}
                  onChange={setKind}
                />
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Run
              </th>
              <th className="px-3 py-2">
                <HeaderFilter
                  label="State"
                  options={unique(rows.map((row) => row.state))}
                  selected={state}
                  onChange={setState}
                />
              </th>
              <th className="px-3 py-2">
                <HeaderFilter
                  label="Failure"
                  options={unique(rows.map((row) => row.failureCode))}
                  selected={failure}
                  onChange={setFailure}
                />
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                HTML
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const key = row.runId ?? `${row.profileId}-${row.acceptedAt}`;
              const instructionItems = row.feedback ?? [];
              const observabilityItems = row.observabilityFeedback ?? [];
              const feedbackRows = [
                ...instructionItems.map((item) => ({
                  kind: "instruction" as const,
                  kindLabel: "指令",
                  ...item,
                })),
                ...observabilityItems.map((item) => ({
                  kind: "observability" as const,
                  kindLabel: "可观测性",
                  ...item,
                })),
              ];
              return (
                <Fragment key={key}>
                  <tr className="border-b border-zinc-200 hover:bg-white">
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-600">
                      {formatTime(row.acceptedAt)}
                    </td>
                    <td className="px-3 py-2 font-medium">{row.profileId}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-600">
                      {row.kindLabel}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                      {row.runId ?? none}
                    </td>
                    <td className={`px-3 py-2 ${stateClass(row.state)}`}>
                      {row.state ?? none}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                      {row.failureCode ?? none}
                    </td>
                    <td className="px-3 py-2">
                      {row.runId && row.hasSessionFile ? (
                        <a
                          href={`/runs/${encodeURIComponent(row.runId)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-700 hover:text-sky-900"
                        >
                          Pi HTML
                        </a>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                  {feedbackRows.length > 0 ? (
                    <tr className="border-b border-zinc-200 bg-zinc-50/80">
                      <td colSpan={7} className="px-3 pt-0 pb-3">
                        <ul className="ml-1 space-y-1">
                          {feedbackRows.map((item) => (
                            <li
                              key={`${item.kind}:${item.priority}:${item.summary}`}
                              className="flex items-start gap-2 text-xs"
                            >
                              <span
                                className={`mt-0.5 rounded px-1.5 py-0.5 font-semibold tracking-wide ${
                                  item.kind === "observability"
                                    ? "bg-sky-100 text-sky-800"
                                    : "bg-violet-100 text-violet-800"
                                }`}
                              >
                                {item.kindLabel}
                              </span>
                              <span
                                className={`mt-0.5 rounded px-1.5 py-0.5 font-semibold tracking-wide uppercase ${
                                  item.priority === "high"
                                    ? "bg-red-100 text-red-800"
                                    : item.priority === "medium"
                                      ? "bg-amber-100 text-amber-800"
                                      : "bg-zinc-200 text-zinc-700"
                                }`}
                              >
                                {item.priority}
                              </span>
                              <span className="text-zinc-700">
                                {item.summary}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            No runs match the current filters.
          </p>
        ) : null}
      </div>
    </Layout>
  );
}
