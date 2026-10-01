import { HomePage } from "./HomePage";
import { Layout } from "./Layout";
import { ProfileDetailPage } from "./ProfileDetailPage";
import { ProfilesPage } from "./ProfilesPage";
import { RunsPage } from "./RunsPage";
import { parseRoute, usePathname } from "./routing";

export default function App() {
  const pathname = usePathname();
  const route = parseRoute(pathname);

  switch (route.name) {
    case "home":
      return <HomePage />;
    case "runs":
      return <RunsPage />;
    case "profiles":
      return <ProfilesPage />;
    case "profile":
      return <ProfileDetailPage id={route.id} />;
    default:
      return (
        <Layout title="Not found" subtitle={`No page for ${pathname}`}>
          <main className="px-6 py-10 text-sm text-zinc-600">
            <a href="/" className="text-sky-700 hover:text-sky-900">
              Back to home
            </a>
          </main>
        </Layout>
      );
  }
}
