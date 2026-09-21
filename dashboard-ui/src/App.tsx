import { useCallback, useEffect, useMemo, useState } from "react";

import { HeaderFilter } from "./HeaderFilter";

export type RunRow = {
  profileId: string;
  acceptedAt: string;
  kind: string;
  scheduleId: string | null;
  kindLabel: string;
  runId: string | null;
  state: string | null;
  failureCode: string | null;
  deliveryState: string | null;
  hasSessionFile: boolean;
};

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

export default function App() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [profile, setProfile] = useState<string[]>([]);
  const [kind, setKind] = useState<string[]>([]);
  const [state, setState] = useState<string[]>([]);
  const [failure, setFailure] = useState<string[]>([]);

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

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
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
      if (!query) return true;
      const haystack = [
        row.profileId,
        row.kindLabel,
        row.runId,
        row.state,
        row.failureCode,
        row.acceptedAt,
        formatTime(row.acceptedAt),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, profile, kind, state, failure, search]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white/90 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-[0.2em] text-sky-700 uppercase">
              Beacon
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Run history
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {filtered.length} of {rows.length} runs · header filters are
              multi-select · Pi HTML opens in a new tab
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search run id, time…"
              className="w-64 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-sky-500/40 placeholder:text-zinc-400 focus:ring-2"
            />
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

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
                  onChange={setProfile}
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
            {filtered.map((row) => (
              <tr
                key={row.runId ?? `${row.profileId}-${row.acceptedAt}`}
                className="border-b border-zinc-200 hover:bg-white"
              >
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
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            No runs match the current filters.
          </p>
        ) : null}
      </div>
    </div>
  );
}
