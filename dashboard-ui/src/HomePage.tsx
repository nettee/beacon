import { Layout } from "./Layout";

export function HomePage() {
  return (
    <Layout
      title="Dashboard"
      subtitle="Choose Run History or Profiles. More sections can grow from here."
    >
      <main className="grid max-w-3xl gap-4 px-6 py-8 sm:grid-cols-2">
        <a
          href="/runs"
          className="block rounded-xl border border-zinc-200 bg-white px-5 py-6 transition hover:border-sky-300 hover:bg-sky-50/40"
        >
          <h2 className="text-lg font-semibold tracking-tight">Run History</h2>
          <p className="mt-2 text-sm text-zinc-500">
            Browse accepted triggers, run state, failures, and open Pi HTML
            sessions.
          </p>
        </a>
        <a
          href="/profiles"
          className="block rounded-xl border border-zinc-200 bg-white px-5 py-6 transition hover:border-sky-300 hover:bg-sky-50/40"
        >
          <h2 className="text-lg font-semibold tracking-tight">Profiles</h2>
          <p className="mt-2 text-sm text-zinc-500">
            List installed Profiles and inspect profile.yaml settings without
            exposing secrets.
          </p>
        </a>
      </main>
    </Layout>
  );
}
