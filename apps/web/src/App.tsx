import { useEffect } from "react";

import { FeedbackPage } from "./FeedbackPage";
import { Layout } from "./Layout";
import { ProfilesPage } from "./ProfilesPage";
import { RunsPage } from "./RunsPage";
import { parseRoute, replaceLocation, usePathname } from "./routing";

export default function App() {
  const pathname = usePathname();
  const route = parseRoute(pathname);

  useEffect(() => {
    if (pathname === "/") {
      replaceLocation("/runs");
    } else if (route.name === "profiles" && route.expandId) {
      replaceLocation("/profiles");
    }
  }, [pathname, route]);

  switch (route.name) {
    case "runs":
      return <RunsPage />;
    case "feedback":
      return <FeedbackPage />;
    case "profiles":
      return <ProfilesPage expandId={route.expandId} />;
    default:
      return (
        <Layout title="Not found" subtitle={`No page for ${pathname}`}>
          <main className="px-6 py-10 text-sm text-zinc-600">
            <a href="/runs" className="text-sky-700 hover:text-sky-900">
              Back to Run History
            </a>
          </main>
        </Layout>
      );
  }
}
