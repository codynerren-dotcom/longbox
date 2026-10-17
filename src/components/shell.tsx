"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BackfillMobileNote, BackfillSidebarNote, BackfillStatusProvider } from "@/components/backfill-status";
import type { BackfillStatus } from "@/lib/covers/files";
import type { EditionJobState } from "@/lib/covers/edition-job";
import type { Viewer } from "@/lib/auth";

const desktopNav = [
  { href: "/", label: "Dashboard" },
  { href: "/collection", label: "Collection" },
  { href: "/keys", label: "Key issues" },
  { href: "/series", label: "Series" },
  { href: "/scan", label: "Scan / Add" },
  { href: "/boxes", label: "Storage boxes" },
  { href: "/wishlist", label: "Wishlist" },
  { href: "/settings", label: "Settings" },
  { href: "/logs", label: "Logs" },
  { href: "/review", label: "Review matches" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  viewer,
  backfill,
  rematch = null,
  proposalCount = 0,
  children,
}: {
  viewer: Viewer;
  backfill: BackfillStatus | null;
  rematch?: EditionJobState | null;
  proposalCount?: number;
  children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <BackfillStatusProvider initial={backfill} rematch={rematch}>
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-white/5 bg-panel md:flex">
        <div className="px-5 pb-4 pt-6">
          <Link href="/" className="block">
            <span className="font-display text-4xl tracking-[0.14em] text-comic">LONGBOX</span>
          </Link>
          <p className="mt-1 text-xs text-mist">Physical comics, one shelf.</p>
        </div>
        <form action="/collection" className="px-4 pb-4">
          <label className="sr-only" htmlFor="sidebar-search">
            Search the collection
          </label>
          <input id="sidebar-search" name="q" placeholder="Search the shelf" className="field" />
        </form>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {desktopNav.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center rounded-xl px-3 py-2 text-sm font-medium ${
                  active ? "bg-comic text-ink" : "text-paper/85 hover:bg-panel2"
                }`}
              >
                {item.label}
                {item.href === "/review" && proposalCount > 0 ? (
                  <span className={`ml-2 rounded-full px-1.5 text-[11px] ${active ? "bg-ink text-comic" : "bg-comic text-ink"}`}>{proposalCount}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <BackfillSidebarNote />
        <div className="space-y-2 px-4 py-5 text-xs text-mist">
          <Link href="/import" className="block font-medium text-paper hover:text-comic">
            Import CLZ CSV
          </Link>
          <Link href="/covers" className="block font-medium text-paper hover:text-comic">
            Cover backfill
          </Link>
          <p>
            {viewer.source === "cloudflare-access" ? "Access" : "Single user"} · {viewer.email}
          </p>
        </div>
      </aside>

      <div className="md:pl-64">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 pb-28 md:px-8 md:py-8 md:pb-10">{children}</div>
      </div>

      <BackfillMobileNote />
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-panel/95 backdrop-blur md:hidden">
        <ul className="grid grid-cols-5 items-end px-2 pb-[max(0.4rem,env(safe-area-inset-bottom))] pt-2">
          <Tab href="/collection" label="Library" active={isActive(pathname, "/collection")} />
          <Tab href="/keys" label="Keys" active={isActive(pathname, "/keys")} />
          <li className="flex justify-center">
            <Link
              href="/scan"
              aria-label="Scan"
              className={`-mt-7 flex h-16 w-16 items-center justify-center rounded-full bg-comic font-display text-xl tracking-wide text-ink shadow-comic ${
                isActive(pathname, "/scan") ? "ring-4 ring-comic/30" : ""
              }`}
            >
              Scan
            </Link>
          </li>
          <Tab href="/" label="Stats" active={pathname === "/"} />
          <Tab href="/more" label="More" active={isActive(pathname, "/more")} />
        </ul>
      </nav>
    </div>
    </BackfillStatusProvider>
  );
}

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <li>
      <Link
        href={href}
        className={`flex flex-col items-center gap-0.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
          active ? "text-comic" : "text-mist"
        }`}
      >
        {label}
      </Link>
    </li>
  );
}
