import { useSyncExternalStore } from "react";

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener("beacon:location", onStoreChange);
  return () => {
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener("beacon:location", onStoreChange);
  };
}

function notifyLocation(): void {
  window.dispatchEvent(new Event("beacon:location"));
}

export function replaceLocation(url: string): void {
  window.history.replaceState(null, "", url);
  notifyLocation();
}

function getPathnameSnapshot(): string {
  return window.location.pathname || "/";
}

function getSearchSnapshot(): string {
  return window.location.search;
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getPathnameSnapshot, () => "/");
}

export function useSearchParams(): string {
  return useSyncExternalStore(subscribe, getSearchSnapshot, () => "");
}

export type Route =
  | { name: "runs" }
  | { name: "feedback" }
  | { name: "profiles"; expandId?: string }
  | { name: "notFound" };

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/runs") return { name: "runs" };
  if (path === "/feedback") return { name: "feedback" };
  if (path === "/profiles") return { name: "profiles" };
  const profile = /^\/profiles\/([^/]+)$/.exec(path);
  if (profile?.[1]) {
    return { name: "profiles", expandId: decodeURIComponent(profile[1]) };
  }
  return { name: "notFound" };
}
