import { useCallback, useEffect, useState } from "react";

import { Layout } from "./Layout";

type NotifyView =
  | { kind: "channel"; name: string; description?: string }
  | { kind: "chat_id"; chatId: string };

type ScheduleView = {
  id: string;
  cron: string;
  timezone: string;
  input: string;
  notify: NotifyView | null;
};

type ListenerView = {
  sources: string[];
  types: string[];
  notify: NotifyView | null;
};

type ProfileDetail = {
  id: string;
  workspace: string;
  runtime: "pi";
  model: { provider: string; id: string };
  admin: { chatId: string } | null;
  schedules: ScheduleView[];
  listener: ListenerView | null;
  secrets: { present: false; note: string };
};

function NotifyBlock({ notify }: { notify: NotifyView | null }) {
  if (!notify) {
    return <span className="text-zinc-400">—</span>;
  }
  if (notify.kind === "channel") {
    return (
      <span className="font-mono text-xs text-zinc-700">
        channel:{notify.name}
        {notify.description ? (
          <span className="ml-2 text-zinc-500">({notify.description})</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="font-mono text-xs text-zinc-700">
      chat_id:{notify.chatId}
    </span>
  );
}

export function ProfileDetailPage({ id }: { id: string }) {
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/profiles/${encodeURIComponent(id)}`);
      if (response.status === 404) {
        throw new Error(`Unknown profile ${id}`);
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text.trim() || `HTTP ${String(response.status)}`);
      }
      const body: unknown = await response.json();
      const next =
        typeof body === "object" &&
        body !== null &&
        "profile" in body &&
        typeof body.profile === "object" &&
        body.profile !== null
          ? (body.profile as ProfileDetail)
          : null;
      if (!next) throw new Error("Invalid profile payload");
      setProfile(next);
    } catch (caught) {
      setProfile(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Layout
      title={profile?.id ?? id}
      subtitle="profile.yaml configuration · Feishu credentials are not exposed"
      actions={
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
        >
          Refresh
        </button>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
        <p className="text-sm">
          <a href="/profiles" className="text-sky-700 hover:text-sky-900">
            ← All profiles
          </a>
        </p>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {loading && !profile ? (
          <p className="text-sm text-zinc-500">Loading profile…</p>
        ) : null}

        {profile ? (
          <>
            <section className="rounded-xl border border-zinc-200 bg-white px-5 py-4">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
                Basics
              </h2>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">Workspace</dt>
                  <dd className="mt-1 font-mono text-xs break-all text-zinc-800">
                    {profile.workspace}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Runtime</dt>
                  <dd className="mt-1 font-mono text-xs text-zinc-800">
                    {profile.runtime}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Model</dt>
                  <dd className="mt-1 font-mono text-xs text-zinc-800">
                    {profile.model.provider}/{profile.model.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Admin</dt>
                  <dd className="mt-1 font-mono text-xs break-all text-zinc-800">
                    {profile.admin ? `chat_id:${profile.admin.chatId}` : "—"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-zinc-200 bg-white px-5 py-4">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
                Schedules ({profile.schedules.length})
              </h2>
              {profile.schedules.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">No schedules.</p>
              ) : (
                <ul className="mt-3 space-y-4">
                  {profile.schedules.map((schedule) => (
                    <li
                      key={schedule.id}
                      className="border-t border-zinc-100 pt-4 first:border-t-0 first:pt-0"
                    >
                      <p className="font-medium text-zinc-900">{schedule.id}</p>
                      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                        <div>
                          <dt className="text-zinc-500">Cron</dt>
                          <dd className="mt-1 font-mono text-xs text-zinc-800">
                            {schedule.cron} · {schedule.timezone}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-zinc-500">Notify</dt>
                          <dd className="mt-1">
                            <NotifyBlock notify={schedule.notify} />
                          </dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className="text-zinc-500">Input</dt>
                          <dd className="mt-1 whitespace-pre-wrap text-zinc-800">
                            {schedule.input}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-zinc-200 bg-white px-5 py-4">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
                Listener
              </h2>
              {!profile.listener ? (
                <p className="mt-3 text-sm text-zinc-500">No listener.</p>
              ) : (
                <dl className="mt-3 grid gap-3 text-sm">
                  <div>
                    <dt className="text-zinc-500">Sources</dt>
                    <dd className="mt-1 space-y-1 font-mono text-xs text-zinc-800">
                      {profile.listener.sources.map((source) => (
                        <div key={source}>{source}</div>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Types</dt>
                    <dd className="mt-1 space-y-1 font-mono text-xs text-zinc-800">
                      {profile.listener.types.map((type) => (
                        <div key={type}>{type}</div>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Notify</dt>
                    <dd className="mt-1">
                      <NotifyBlock notify={profile.listener.notify} />
                    </dd>
                  </div>
                </dl>
              )}
            </section>

            <section className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-5 py-4">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
                Secrets
              </h2>
              <p className="mt-2 text-sm text-zinc-600">
                {profile.secrets.note}
              </p>
            </section>
          </>
        ) : null}
      </div>
    </Layout>
  );
}
