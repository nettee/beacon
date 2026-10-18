import type { CostStatsResponse } from "@nettee/beacon-shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import { HeaderFilter } from "./HeaderFilter";
import { Layout } from "./Layout";
import { replaceLocation, usePathname, useSearchParams } from "./routing";

type Period = "1d" | "7d";

function profilesFromSearch(search: string): string[] {
  const params = new URLSearchParams(search);
  return params
    .getAll("profile")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function periodFromSearch(search: string): Period {
  const value = new URLSearchParams(search).get("period");
  return value === "1d" ? "1d" : "7d";
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function formatRange(from: string, to: string, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${fmt.format(new Date(from))} → ${fmt.format(new Date(to))}`;
}

export function CostStatsPage() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [period, setPeriod] = useState<Period>(() => periodFromSearch(search));
  const [profile, setProfile] = useState<string[]>(() =>
    profilesFromSearch(search),
  );
  const [stats, setStats] = useState<CostStatsResponse | null>(null);
  const [profileOptions, setProfileOptions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPeriod(periodFromSearch(search));
    setProfile(profilesFromSearch(search));
  }, [search]);

  const syncUrl = useCallback((nextPeriod: Period, nextProfiles: string[]) => {
    const url = new URL(window.location.href);
    url.pathname = "/cost";
    url.searchParams.set("period", nextPeriod);
    url.searchParams.delete("profile");
    for (const value of nextProfiles) {
      url.searchParams.append("profile", value);
    }
    replaceLocation(`${url.pathname}${url.search}${url.hash}`);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("period", period);
      for (const value of profile) params.append("profile", value);
      const response = await fetch(`/api/cost-stats?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body = (await response.json()) as CostStatsResponse;
      setStats(body);
      setProfileOptions((current) => {
        const next = new Set(current);
        for (const row of body.byProfile) next.add(row.profileId);
        return [...next].sort((left, right) => left.localeCompare(right));
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [period, profile]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/profiles");
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "profiles" in body &&
          Array.isArray(body.profiles)
        ) {
          setProfileOptions(
            body.profiles
              .map((item) =>
                typeof item === "object" &&
                item !== null &&
                "id" in item &&
                typeof item.id === "string"
                  ? item.id
                  : null,
              )
              .filter((id): id is string => Boolean(id))
              .sort((left, right) => left.localeCompare(right)),
          );
        }
      } catch {
        // Cost API still works without the profile list.
      }
    })();
  }, []);

  const maxDailyCost = useMemo(() => {
    if (!stats || stats.daily.length === 0) return 0;
    return Math.max(...stats.daily.map((row) => row.cost.total), 0);
  }, [stats]);

  const onPeriodChange = (next: Period) => {
    setPeriod(next);
    syncUrl(next, profile);
  };

  const onProfileChange = (next: string[]) => {
    setProfile(next);
    syncUrl(period, next);
  };

  const subtitle = stats
    ? `${formatRange(stats.from, stats.to, stats.timezone)} · ${stats.timezone}`
    : "按 Profile 汇总 Pi session 用量与费用";

  return (
    <Layout
      title="成本统计"
      subtitle={subtitle}
      pathname={pathname}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-zinc-300 bg-white p-0.5 text-sm">
            {(
              [
                ["1d", "近 1 天"],
                ["7d", "近 7 天"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => onPeriodChange(value)}
                className={`rounded-md px-3 py-1.5 ${
                  period === value
                    ? "bg-sky-100 font-medium text-sky-900"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <HeaderFilter
            label="Profile"
            options={profileOptions}
            selected={profile}
            onChange={onProfileChange}
          />
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            刷新
          </button>
        </div>
      }
    >
      {error ? <p className="px-6 py-4 text-sm text-red-600">{error}</p> : null}
      {loading && !stats ? (
        <p className="px-6 py-4 text-sm text-zinc-500">加载成本统计…</p>
      ) : null}

      {stats ? (
        <div className="space-y-8 px-6 py-6">
          <section className="flex flex-wrap gap-x-10 gap-y-4 border-b border-zinc-200 pb-6">
            <Metric
              label="总成本"
              value={formatCost(stats.totals.cost.total)}
            />
            <Metric
              label="Token 总量"
              value={formatTokens(stats.totals.totalTokens)}
            />
            <Metric label="Runs" value={String(stats.totals.runCount)} />
            <Metric
              label="有用量 / 缺用量"
              value={`${String(stats.totals.runsWithUsage)} / ${String(stats.totals.runsMissingUsage)}`}
            />
          </section>

          <section>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase">
              按 Profile
            </h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead className="bg-zinc-50">
                  <tr className="border-b border-zinc-200">
                    <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                      Profile
                    </th>
                    <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                      Runs
                    </th>
                    <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                      Tokens
                    </th>
                    <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                      Cost
                    </th>
                    <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                      In / Out / Cache
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byProfile.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-3 py-6 text-sm text-zinc-500"
                      >
                        该时间范围内没有 Run。
                      </td>
                    </tr>
                  ) : (
                    stats.byProfile.map((row) => (
                      <tr
                        key={row.profileId}
                        className="border-b border-zinc-200 hover:bg-white"
                      >
                        <td className="px-3 py-2 font-medium">
                          {row.profileId}
                        </td>
                        <td className="px-3 py-2 text-zinc-600">
                          {row.runCount}
                          {row.runsMissingUsage > 0
                            ? `（缺 ${String(row.runsMissingUsage)}）`
                            : ""}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                          {formatTokens(row.totalTokens)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-900">
                          {formatCost(row.cost.total)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                          {formatTokens(row.input)} / {formatTokens(row.output)}{" "}
                          / {formatTokens(row.cacheRead + row.cacheWrite)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase">
              按日明细
            </h2>
            <div className="mt-3 space-y-2">
              {stats.daily.length === 0 ? (
                <p className="text-sm text-zinc-500">暂无按日数据。</p>
              ) : (
                stats.daily.map((row) => {
                  const width =
                    maxDailyCost > 0
                      ? Math.max(4, (row.cost.total / maxDailyCost) * 100)
                      : 0;
                  return (
                    <div
                      key={row.date}
                      className="grid grid-cols-[7rem_1fr_auto] items-center gap-3"
                    >
                      <div className="font-mono text-xs text-zinc-600">
                        {row.date}
                      </div>
                      <div className="h-2 overflow-hidden rounded bg-zinc-200">
                        <div
                          className="h-full rounded bg-sky-500/80"
                          style={{ width: `${String(width)}%` }}
                        />
                      </div>
                      <div className="min-w-[10rem] text-right font-mono text-xs text-zinc-700">
                        {formatCost(row.cost.total)} ·{" "}
                        {formatTokens(row.totalTokens)} tok · {row.runCount}{" "}
                        runs
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <p className="mt-4 text-xs text-zinc-500">
              费用与 token 来自持久化的{" "}
              <code className="font-mono">run.usage</code>
              （Pi session JSONL 在 Run 结束时写入）。历史 Run 需先执行{" "}
              <code className="font-mono">beacon migrate-usage</code>{" "}
              一次性回填；Dashboard 不会在请求时扫描 JSONL。
            </p>
          </section>
        </div>
      ) : null}
    </Layout>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">
        {value}
      </div>
    </div>
  );
}
