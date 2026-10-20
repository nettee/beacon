import type {
  ModelAllocationProfileView,
  ModelAllocationsResponse,
} from "@nettee/beacon-shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Layout } from "./Layout";

type DraftMap = Record<string, Record<string, number>>;

function formatModel(model: {
  provider: string;
  id: string;
  thinking?: string | undefined;
}): string {
  const base = `${model.provider}/${model.id}`;
  return model.thinking ? `${base} · thinking:${model.thinking}` : base;
}

function draftsFromProfiles(profiles: ModelAllocationProfileView[]): DraftMap {
  const next: DraftMap = {};
  for (const profile of profiles) {
    const row: Record<string, number> = {};
    for (const entry of profile.allocations) {
      if (profile.mapped) {
        row[entry.key] = entry.percent;
      } else {
        // Unmapped: default editor to 100% deepseek (save overwrites).
        row[entry.key] = entry.key === "deepseek-v4.1-flash" ? 100 : 0;
      }
    }
    next[profile.profileId] = row;
  }
  return next;
}

function sumPercents(row: Record<string, number> | undefined): number {
  if (!row) return 0;
  return Object.values(row).reduce((acc, value) => acc + value, 0);
}

export function ModelAllocationPage() {
  const [data, setData] = useState<ModelAllocationsResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/model-allocations");
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text.trim() || `HTTP ${String(response.status)}`);
      }
      const body = (await response.json()) as ModelAllocationsResponse;
      setData(body);
      setDrafts(draftsFromProfiles(body.profiles));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choiceOrder = useMemo(
    () => data?.choices.map((choice) => choice.key) ?? [],
    [data],
  );

  const setPercent = (
    profileId: string,
    key: string,
    raw: string,
    pairedKey: string,
  ) => {
    const parsed = Number(raw);
    const value = Number.isFinite(parsed)
      ? Math.max(0, Math.min(100, Math.round(parsed)))
      : 0;
    setDrafts((current) => {
      const prev = current[profileId] ?? {};
      return {
        ...current,
        [profileId]: {
          ...prev,
          [key]: value,
          [pairedKey]: 100 - value,
        },
      };
    });
    setMessages((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  };

  const save = async (profileId: string) => {
    const row = drafts[profileId];
    if (!row) return;
    const total = sumPercents(row);
    if (total !== 100) {
      setMessages((current) => ({
        ...current,
        [profileId]: `百分比之和须为 100（当前 ${String(total)}）`,
      }));
      return;
    }
    setSavingId(profileId);
    setMessages((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
    try {
      const response = await fetch(
        `/api/profiles/${encodeURIComponent(profileId)}/model-allocation`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ percents: row }),
        },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text.trim() || `HTTP ${String(response.status)}`);
      }
      const body = (await response.json()) as {
        profile: ModelAllocationProfileView;
        appliesOnRestart: true;
      };
      setData((current) => {
        if (!current) return current;
        return {
          ...current,
          profiles: current.profiles.map((profile) =>
            profile.profileId === profileId ? body.profile : profile,
          ),
        };
      });
      setDrafts((current) => ({
        ...current,
        [profileId]: draftsFromProfiles([body.profile])[profileId] ?? row,
      }));
      setMessages((current) => ({
        ...current,
        [profileId]:
          "已写入 profile.yaml。正在运行的 beacon serve 需重启后新 Run 才生效；beacon trigger 立即读盘。",
      }));
    } catch (caught) {
      setMessages((current) => ({
        ...current,
        [profileId]: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      setSavingId(null);
    }
  };

  const preset = (profileId: string, a: number, b: number) => {
    if (choiceOrder.length < 2) return;
    const [first, second] = choiceOrder;
    if (!first || !second) return;
    setDrafts((current) => ({
      ...current,
      [profileId]: {
        ...(current[profileId] ?? {}),
        [first]: a,
        [second]: b,
      },
    }));
    setMessages((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  };

  return (
    <Layout
      title="模型分配"
      subtitle="按 Profile 查看 / 调整 model_pool 比例（仅两个白名单模型）"
      actions={
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          Refresh
        </button>
      }
    >
      <div className="space-y-4 px-6 py-4">
        <p className="max-w-3xl text-sm text-zinc-600">
          白名单：
          <span className="font-medium text-zinc-800">
            {" "}
            (openai-codex) gpt-6-luna • high
          </span>
          {" · "}
          <span className="font-medium text-zinc-800">
            opencode-go / deepseek-v4.1-flash
          </span>
          。100% 其一会钉死
          <code className="mx-1 rounded bg-zinc-100 px-1 text-xs">model</code>
          并清除
          <code className="mx-1 rounded bg-zinc-100 px-1 text-xs">
            model_pool
          </code>
          。Dashboard 无鉴权（与现有页相同）。
        </p>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {loading && !data ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : null}

        <ul className="space-y-4">
          {(data?.profiles ?? []).map((profile) => {
            const draft = drafts[profile.profileId] ?? {};
            const keys = choiceOrder;
            const first = keys[0];
            const second = keys[1];
            const total = sumPercents(draft);
            const dirty =
              profile.mapped &&
              profile.allocations.some(
                (entry) => draft[entry.key] !== entry.percent,
              );
            const unmappedDirty = !profile.mapped;
            return (
              <li
                key={profile.profileId}
                className="rounded-lg border border-zinc-200 bg-white px-4 py-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-zinc-900">
                      {profile.profileId}
                    </h2>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {profile.error
                        ? `load error · ${profile.error}`
                        : profile.mode === "pool"
                          ? "model_pool"
                          : "single model"}
                      {profile.mapped ? "" : " · 当前不在白名单（保存将覆盖）"}
                    </p>
                  </div>
                  <p className="font-mono text-xs text-zinc-600">
                    primary: {formatModel(profile.model)}
                  </p>
                </div>

                {profile.modelPool && profile.modelPool.length > 0 ? (
                  <p className="mt-2 font-mono text-xs text-zinc-500">
                    pool:{" "}
                    {profile.modelPool
                      .map(
                        (entry) =>
                          `${formatModel(entry)}=${String(entry.weight)}`,
                      )
                      .join(" · ")}
                  </p>
                ) : null}

                {profile.error ? null : (
                  <div className="mt-4 space-y-3">
                    {(data?.choices ?? []).map((choice) => (
                      <label
                        key={choice.key}
                        className="flex flex-wrap items-center gap-3 text-sm"
                      >
                        <span className="min-w-[16rem] text-zinc-800">
                          {choice.label}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={draft[choice.key] ?? 0}
                          disabled={!first || !second}
                          onChange={(event) => {
                            if (!first || !second) return;
                            const paired =
                              choice.key === first ? second : first;
                            setPercent(
                              profile.profileId,
                              choice.key,
                              event.target.value,
                              paired,
                            );
                          }}
                          className="h-2 w-40 accent-sky-600"
                        />
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={draft[choice.key] ?? 0}
                          disabled={!first || !second}
                          onChange={(event) => {
                            if (!first || !second) return;
                            const paired =
                              choice.key === first ? second : first;
                            setPercent(
                              profile.profileId,
                              choice.key,
                              event.target.value,
                              paired,
                            );
                          }}
                          className="w-16 rounded-md border border-zinc-300 px-2 py-1 font-mono text-xs"
                        />
                        <span className="text-xs text-zinc-500">%</span>
                      </label>
                    ))}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                        onClick={() => preset(profile.profileId, 50, 50)}
                      >
                        50/50
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                        onClick={() => preset(profile.profileId, 70, 30)}
                      >
                        70/30
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                        onClick={() => preset(profile.profileId, 100, 0)}
                      >
                        100% luna
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                        onClick={() => preset(profile.profileId, 0, 100)}
                      >
                        100% deepseek
                      </button>
                      <button
                        type="button"
                        disabled={
                          savingId === profile.profileId ||
                          total !== 100 ||
                          (!dirty && !unmappedDirty && total === 100)
                        }
                        onClick={() => void save(profile.profileId)}
                        className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                      >
                        {savingId === profile.profileId ? "Saving…" : "Save"}
                      </button>
                      <span
                        className={`text-xs ${
                          total === 100 ? "text-zinc-500" : "text-red-600"
                        }`}
                      >
                        sum {String(total)}%
                      </span>
                    </div>
                    {messages[profile.profileId] ? (
                      <p className="text-xs text-zinc-600">
                        {messages[profile.profileId]}
                      </p>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {data && data.profiles.length === 0 && !loading ? (
          <p className="text-sm text-zinc-500">No profiles found.</p>
        ) : null}
      </div>
    </Layout>
  );
}
