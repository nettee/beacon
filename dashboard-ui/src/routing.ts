import { useSyncExternalStore } from "react";

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

function getSnapshot(): string {
  return window.location.pathname || "/";
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => "/");
}

export type Route =
  | { name: "home" }
  | { name: "runs" }
  | { name: "profiles" }
  | { name: "profile"; id: string }
  | { name: "notFound" };

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/runs") return { name: "runs" };
  if (path === "/profiles") return { name: "profiles" };
  const profile = /^\/profiles\/([^/]+)$/.exec(path);
  if (profile?.[1]) {
    return { name: "profile", id: decodeURIComponent(profile[1]) };
  }
  return { name: "notFound" };
}
