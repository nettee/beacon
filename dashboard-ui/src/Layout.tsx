import type { ReactNode } from "react";

type LayoutProps = {
  children: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  pathname?: string;
};

const links = [
  { href: "/", label: "Home", match: (path: string) => path === "/" },
  {
    href: "/runs",
    label: "Run History",
    match: (path: string) => path === "/runs" || path.startsWith("/runs/"),
  },
  {
    href: "/profiles",
    label: "Profiles",
    match: (path: string) =>
      path === "/profiles" || path.startsWith("/profiles/"),
  },
] as const;

export function Layout({
  children,
  title,
  subtitle,
  actions,
  pathname,
}: LayoutProps) {
  const path =
    pathname ??
    (typeof window === "undefined" ? "/" : window.location.pathname || "/");

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white/90 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-[0.2em] text-sky-700 uppercase">
              Beacon
            </p>
            <nav className="mt-2 flex flex-wrap gap-1 text-sm">
              {links.map((link) => {
                const active = link.match(path);
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    className={`rounded-md px-2.5 py-1 ${
                      active
                        ? "bg-sky-100 font-medium text-sky-900"
                        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                    }`}
                  >
                    {link.label}
                  </a>
                );
              })}
            </nav>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex items-center gap-3">{actions}</div>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}
