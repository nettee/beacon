import { Fragment, useCallback, useEffect, useState } from "react";

import { Layout } from "./Layout";

export type ProfileListItem = {
  id: string;
  workspace: string;
  runtime: "pi";
  model: { provider: string; id: string };
  scheduleCount: number;
  hasAdmin: boolean;
  hasListener: boolean;
  error: string | null;
};

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

function ProfileDetailPanel({ profile }: { profile: ProfileDetail }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          profile.yaml · Feishu credentials are not exposed
        </p>
        <a
          href={`/runs?profile=${encodeURIComponent(profile.id)}`}
          className="text-sm text-sky-700 hover:text-sky-900"
        >
          View runs →
        </a>
      </div>

      <section>
        <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Basics
        </h3>
        <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
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

      <section>
        <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Schedules ({profile.schedules.length})
        </h3>
        {profile.schedules.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No schedules.</p>
        ) : (
          <ul className="mt-2 space-y-4">
            {profile.schedules.map((schedule) => (
              <li
                key={schedule.id}
                className="border-t border-zinc-200 pt-3 first:border-t-0 first:pt-0"
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

      <section>
        <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Listener
        </h3>
        {!profile.listener ? (
          <p className="mt-2 text-sm text-zinc-500">No listener.</p>
        ) : (
          <dl className="mt-2 grid gap-3 text-sm">
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

      <section className="rounded-md border border-dashed border-zinc-300 bg-white/70 px-4 py-3">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Secrets
        </h3>
        <p className="mt-1 text-sm text-zinc-600">{profile.secrets.note}</p>
      </section>
    </div>
  );
}

export function ProfilesPage({ expandId }: { expandId?: string }) {
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(expandId ?? null);
  const [details, setDetails] = useState<Record<string, ProfileDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>(
    {},
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/profiles");
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body: unknown = await response.json();
      const rows =
        typeof body === "object" &&
        body !== null &&
        "profiles" in body &&
        Array.isArray(body.profiles)
          ? (body.profiles as ProfileListItem[])
          : [];
      setProfiles(rows);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading((current) => ({ ...current, [id]: true }));
    setDetailErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
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
      setDetails((current) => ({ ...current, [id]: next }));
    } catch (caught) {
      setDetailErrors((current) => ({
        ...current,
        [id]: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      setDetailLoading((current) => ({ ...current, [id]: false }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (expandId) setExpandedId(expandId);
  }, [expandId]);

  useEffect(() => {
    if (!expandedId) return;
    if (details[expandedId] || detailErrors[expandedId]) return;
    void loadDetail(expandedId);
  }, [expandedId, details, detailErrors, loadDetail]);

  const toggle = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  };

  return (
    <Layout
      title="Profiles"
      subtitle={`${String(profiles.length)} profiles · expand a row for details · secrets are never shown`}
    >
      {error ? <p className="px-6 py-4 text-sm text-red-600">{error}</p> : null}
      {loading && profiles.length === 0 ? (
        <p className="px-6 py-4 text-sm text-zinc-500">Loading profiles…</p>
      ) : null}

      <div className="overflow-x-auto px-6 py-4">
        <table className="w-full min-w-[760px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-50">
            <tr className="border-b border-zinc-200">
              <th className="w-10 px-3 py-2" aria-label="Expand" />
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Profile
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Model
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Workspace
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Schedules
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Admin
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Listener
              </th>
              <th className="px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                Runs
              </th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => {
              const open = expandedId === profile.id;
              const detail = details[profile.id];
              return (
                <Fragment key={profile.id}>
                  <tr
                    className={`border-b border-zinc-200 ${
                      open ? "bg-white" : "hover:bg-white"
                    }`}
                  >
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={
                          open
                            ? `Collapse ${profile.id}`
                            : `Expand ${profile.id}`
                        }
                        onClick={() => toggle(profile.id)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          className={`h-3.5 w-3.5 transition-transform ${
                            open ? "rotate-90" : ""
                          }`}
                          aria-hidden="true"
                        >
                          <path
                            fill="currentColor"
                            d="M6 3.5 11 8l-5 4.5V3.5z"
                          />
                        </svg>
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => toggle(profile.id)}
                        className="font-medium text-zinc-900 hover:text-sky-800"
                      >
                        {profile.id}
                      </button>
                      {profile.error ? (
                        <p className="mt-1 text-xs text-red-600">
                          {profile.error}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-600">
                      {profile.model.provider
                        ? `${profile.model.provider}/${profile.model.id}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                      {profile.workspace || "—"}
                    </td>
                    <td className="px-3 py-2 text-zinc-700">
                      {profile.scheduleCount}
                    </td>
                    <td className="px-3 py-2 text-zinc-700">
                      {profile.hasAdmin ? "yes" : "—"}
                    </td>
                    <td className="px-3 py-2 text-zinc-700">
                      {profile.hasListener ? "yes" : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        href={`/runs?profile=${encodeURIComponent(profile.id)}`}
                        className="text-sky-700 hover:text-sky-900"
                      >
                        View
                      </a>
                    </td>
                  </tr>
                  {open ? (
                    <tr className="border-b border-zinc-200 bg-zinc-50/90">
                      <td colSpan={8} className="px-5 py-4">
                        {detailLoading[profile.id] && !detail ? (
                          <p className="text-sm text-zinc-500">
                            Loading profile…
                          </p>
                        ) : null}
                        {detailErrors[profile.id] ? (
                          <p className="text-sm text-red-600">
                            {detailErrors[profile.id]}
                          </p>
                        ) : null}
                        {detail ? (
                          <ProfileDetailPanel profile={detail} />
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {profiles.length === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            No profiles found.
          </p>
        ) : null}
      </div>
    </Layout>
  );
}
