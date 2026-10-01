import { useCallback, useEffect, useState } from "react";

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

export function ProfilesPage() {
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Layout
      title="Profiles"
      subtitle={`${String(profiles.length)} profiles · configuration from profile.yaml · secrets are never shown`}
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
      {error ? <p className="px-6 py-4 text-sm text-red-600">{error}</p> : null}
      {loading && profiles.length === 0 ? (
        <p className="px-6 py-4 text-sm text-zinc-500">Loading profiles…</p>
      ) : null}

      <div className="overflow-x-auto px-6 py-4">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-50">
            <tr className="border-b border-zinc-200">
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
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <tr
                key={profile.id}
                className="border-b border-zinc-200 hover:bg-white"
              >
                <td className="px-3 py-2">
                  <a
                    href={`/profiles/${encodeURIComponent(profile.id)}`}
                    className="font-medium text-sky-700 hover:text-sky-900"
                  >
                    {profile.id}
                  </a>
                  {profile.error ? (
                    <p className="mt-1 text-xs text-red-600">{profile.error}</p>
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
              </tr>
            ))}
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
