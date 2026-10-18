import type { CostStatsResponse } from "@nettee/beacon-shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import { HeaderFilter } from "./HeaderFilter";
import { Layout } from "./Layout";
import { replaceLocation, usePathname, useSearchParams } from "./routing";

type Period = "1d" | "7d";

type DailyPoint = {
  date: string;
  cost: number;
  totalTokens: number;
  runCount: number;
};

const PROFILE_COLORS = [
  "#0ea5e9", // sky-500
  "#14b8a6", // teal-500
  "#f59e0b", // amber-500
  "#f43f5e", // rose-500
  "#64748b", // slate-500
  "#84cc16", // lime-500
  "#06b6d4", // cyan-500
  "#e11d48", // rose-600
] as const;

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

function shortDate(date: string): string {
  // YYYY-MM-DD → MM-DD
  return date.length >= 10 ? date.slice(5) : date;
}

function colorForProfile(profileId: string, orderedIds: string[]): string {
  const index = orderedIds.indexOf(profileId);
  const safe = index >= 0 ? index : 0;
  return PROFILE_COLORS[safe % PROFILE_COLORS.length] ?? PROFILE_COLORS[0];
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
  const [chartProfile, setChartProfile] = useState<string | null>(null);
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

  const profileIdsOrdered = useMemo(() => {
    if (!stats) return [] as string[];
    return stats.byProfile.map((row) => row.profileId);
  }, [stats]);

  // Keep chart profile selection valid when data/filter changes.
  useEffect(() => {
    if (profileIdsOrdered.length === 0) {
      setChartProfile(null);
      return;
    }
    setChartProfile((current) =>
      current && profileIdsOrdered.includes(current)
        ? current
        : (profileIdsOrdered[0] ?? null),
    );
  }, [profileIdsOrdered]);

  const totalDailyPoints: DailyPoint[] = useMemo(() => {
    if (!stats) return [];
    return stats.daily.map((row) => ({
      date: row.date,
      cost: row.cost.total,
      totalTokens: row.totalTokens,
      runCount: row.runCount,
    }));
  }, [stats]);

  const dates = useMemo(
    () => totalDailyPoints.map((row) => row.date),
    [totalDailyPoints],
  );

  const profileDailyPoints: DailyPoint[] = useMemo(() => {
    if (!stats || !chartProfile) return [];
    const byDate = new Map(
      stats.dailyByProfile
        .filter((row) => row.profileId === chartProfile)
        .map((row) => [row.date, row] as const),
    );
    // Align to the full daily axis so empty days still show as zero bars.
    const axis =
      dates.length > 0
        ? dates
        : [...byDate.keys()].sort((left, right) => left.localeCompare(right));
    return axis.map((date) => {
      const row = byDate.get(date);
      return {
        date,
        cost: row?.cost.total ?? 0,
        totalTokens: row?.totalTokens ?? 0,
        runCount: row?.runCount ?? 0,
      };
    });
  }, [stats, chartProfile, dates]);

  const stackedSeries = useMemo(() => {
    if (!stats || dates.length === 0) {
      return {
        dates: [] as string[],
        profiles: [] as string[],
        shares: [] as number[][],
      };
    }
    const profiles = profileIdsOrdered;
    const costByDateProfile = new Map<string, number>();
    for (const row of stats.dailyByProfile) {
      costByDateProfile.set(`${row.date}\0${row.profileId}`, row.cost.total);
    }
    const shares = dates.map((date) => {
      const costs = profiles.map(
        (id) => costByDateProfile.get(`${date}\0${id}`) ?? 0,
      );
      const sum = costs.reduce((acc, value) => acc + value, 0);
      if (sum <= 0) return profiles.map(() => 0);
      return costs.map((value) => value / sum);
    });
    return { dates, profiles, shares };
  }, [stats, dates, profileIdsOrdered]);

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
                          <span className="inline-flex items-center gap-2">
                            <span
                              className="inline-block size-2.5 rounded-sm"
                              style={{
                                backgroundColor: colorForProfile(
                                  row.profileId,
                                  profileIdsOrdered,
                                ),
                              }}
                              aria-hidden
                            />
                            {row.profileId}
                          </span>
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
              每日总成本
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              横轴为日期，纵轴为当日合计费用。
            </p>
            <div className="mt-4">
              <DailyBarChart points={totalDailyPoints} barColor="#0ea5e9" />
            </div>
          </section>

          <section>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase">
                  每日成本 · Profile
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  选择单个 Profile，查看其按日费用柱状图。
                </p>
              </div>
              {profileIdsOrdered.length > 0 ? (
                <label className="flex items-center gap-2 text-sm text-zinc-600">
                  <span className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Profile
                  </span>
                  <select
                    value={chartProfile ?? ""}
                    onChange={(event) => setChartProfile(event.target.value)}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 outline-none ring-sky-500/40 focus:ring-2"
                  >
                    {profileIdsOrdered.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="mt-4">
              <DailyBarChart
                points={profileDailyPoints}
                barColor={
                  chartProfile
                    ? colorForProfile(chartProfile, profileIdsOrdered)
                    : "#0ea5e9"
                }
                emptyLabel={
                  profileIdsOrdered.length === 0
                    ? "该时间范围内没有 Profile 数据。"
                    : undefined
                }
              />
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase">
              每日成本占比
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              100% 堆积面积图：每日合计为 100%，分段为各 Profile 费用占比。
            </p>
            <div className="mt-4">
              <StackedShareAreaChart
                dates={stackedSeries.dates}
                profiles={stackedSeries.profiles}
                shares={stackedSeries.shares}
              />
            </div>
            {stackedSeries.profiles.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-600">
                {stackedSeries.profiles.map((id) => (
                  <li key={id} className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block size-2.5 rounded-sm"
                      style={{
                        backgroundColor: colorForProfile(id, profileIdsOrdered),
                      }}
                      aria-hidden
                    />
                    {id}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-4 text-xs text-zinc-500">
              费用与 token 来自持久化的{" "}
              <code className="font-mono">run.usage</code>
              （Pi session JSONL 在 Run 结束时写入）。Dashboard
              只读已落盘用量，不会在请求时扫描 JSONL。
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

function DailyBarChart({
  points,
  barColor,
  emptyLabel = "暂无按日数据。",
}: {
  points: DailyPoint[];
  barColor: string;
  emptyLabel?: string;
}) {
  const maxCost = Math.max(...points.map((row) => row.cost), 0);

  if (points.length === 0) {
    return <p className="text-sm text-zinc-500">{emptyLabel}</p>;
  }

  return (
    <div className="w-full">
      <div className="flex h-44 items-end gap-2 border-b border-zinc-200 pb-0 sm:gap-3">
        {points.map((row) => {
          const heightPct =
            maxCost > 0
              ? Math.max(row.cost > 0 ? 4 : 0, (row.cost / maxCost) * 100)
              : 0;
          const title = `${row.date}: ${formatCost(row.cost)} · ${formatTokens(row.totalTokens)} tok · ${String(row.runCount)} runs`;
          return (
            <div
              key={row.date}
              className="flex min-w-0 flex-1 flex-col items-center justify-end"
              title={title}
            >
              <div className="mb-1 font-mono text-[10px] text-zinc-500 tabular-nums">
                {row.cost > 0 ? formatCost(row.cost) : ""}
              </div>
              <div className="flex h-32 w-full max-w-14 items-end justify-center">
                <div
                  className="w-full max-w-10 rounded-t transition-[height]"
                  style={{
                    height: `${String(heightPct)}%`,
                    backgroundColor: barColor,
                    opacity: 0.85,
                    minHeight: row.cost > 0 ? 2 : 0,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 sm:gap-3">
        {points.map((row) => (
          <div
            key={`${row.date}-label`}
            className="min-w-0 flex-1 text-center font-mono text-[10px] text-zinc-500"
          >
            {shortDate(row.date)}
          </div>
        ))}
      </div>
    </div>
  );
}

function StackedShareAreaChart({
  dates,
  profiles,
  shares,
}: {
  dates: string[];
  profiles: string[];
  shares: number[][];
}) {
  if (dates.length === 0 || profiles.length === 0) {
    return <p className="text-sm text-zinc-500">暂无占比数据。</p>;
  }

  const width = 640;
  const height = 200;
  const padL = 36;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = dates.length;

  const xAt = (i: number): number => {
    if (n === 1) return padL + plotW / 2;
    return padL + (i / (n - 1)) * plotW;
  };
  const yAt = (shareFromTop: number): number => padT + shareFromTop * plotH;

  // Build stacked bands: for each profile, top and bottom cumulative share paths.
  const bands = profiles.map((profileId, profileIndex) => {
    const topPoints: Array<{ x: number; y: number }> = [];
    const bottomPoints: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < n; i += 1) {
      const dayShares = shares[i] ?? [];
      let below = 0;
      for (let j = 0; j < profileIndex; j += 1) {
        below += dayShares[j] ?? 0;
      }
      const value = dayShares[profileIndex] ?? 0;
      // y=0 at top of chart → share stacked from bottom (100% at bottom? No:
      // 100% stacked area typically stacks from bottom up. Bottom of plot = 0%, top = 100%.
      // So y for cumulative bottom = padT + (1 - below) * plotH? Wait.
      // Standard: bottom of chart is 0%, top is 100%.
      // Segment from cumulative `below` to `below+value`.
      const yBottom = yAt(1 - below); // higher share from bottom → lower on screen when below=0 → y=padT+plotH
      const yTop = yAt(1 - (below + value));
      topPoints.push({ x: xAt(i), y: yTop });
      bottomPoints.push({ x: xAt(i), y: yBottom });
    }
    const path = [
      ...topPoints.map(
        (p, i) => `${i === 0 ? "M" : "L"}${String(p.x)},${String(p.y)}`,
      ),
      ...bottomPoints
        .slice()
        .reverse()
        .map((p) => `L${String(p.x)},${String(p.y)}`),
      "Z",
    ].join(" ");
    return { profileId, path };
  });

  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="h-52 w-full min-w-[28rem] text-zinc-400"
        role="img"
        aria-label="Daily cost share by profile, 100% stacked area"
      >
        {yTicks.map((tick) => {
          const y = yAt(1 - tick);
          return (
            <g key={tick}>
              <line
                x1={padL}
                x2={width - padR}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.25}
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-zinc-500"
                fontSize={10}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {`${String(Math.round(tick * 100))}%`}
              </text>
            </g>
          );
        })}
        {bands.map((band) => (
          <path
            key={band.profileId}
            d={band.path}
            fill={colorForProfile(band.profileId, profiles)}
            fillOpacity={0.75}
            stroke="white"
            strokeWidth={0.5}
          >
            <title>{band.profileId}</title>
          </path>
        ))}
        {dates.map((date, i) => (
          <text
            key={date}
            x={xAt(i)}
            y={height - 8}
            textAnchor="middle"
            className="fill-zinc-500"
            fontSize={10}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {shortDate(date)}
          </text>
        ))}
      </svg>
    </div>
  );
}
