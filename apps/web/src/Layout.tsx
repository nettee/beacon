import type { ReactNode } from "react";

type LayoutProps = {
  children: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  pathname?: string;
};

const links = [
  {
    href: "/runs",
    label: "Run History",
    match: (path: string) =>
      path === "/" || path === "/runs" || path.startsWith("/runs/"),
  },
  {
    href: "/feedback",
    label: "Feedback",
    match: (path: string) =>
      path === "/feedback" || path.startsWith("/feedback/"),
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
    <div className="min-h-screen bg-zinc-50 text-zinc-900 md:flex">
      <aside className="shrink-0 border-b border-zinc-200 bg-white md:sticky md:top-0 md:flex md:h-screen md:w-56 md:flex-col md:border-r md:border-b-0">
        <div className="px-4 py-4 md:px-5 md:pt-5 md:pb-3">
          <a
            href="/runs"
            className="inline-flex items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-600"
          >
            <img
              src="/beacon-icon.svg"
              alt=""
              width={40}
              height={40}
              className="size-10 shrink-0"
            />
            <span className="text-xl font-semibold tracking-tight text-zinc-900">
              Beacon
            </span>
          </a>
        </div>
        <nav
          className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-0.5 md:overflow-visible md:px-3 md:pb-4"
          aria-label="Primary"
        >
          {links.map((link) => {
            const active = link.match(path);
            return (
              <a
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${
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
      </aside>

      <div className="min-w-0 flex-1">
        <header className="border-b border-zinc-200 bg-white/90 px-6 py-4 backdrop-blur">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle ? (
                <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
              ) : null}
            </div>
            {actions ? (
              <div className="flex flex-wrap items-center gap-3">{actions}</div>
            ) : null}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
