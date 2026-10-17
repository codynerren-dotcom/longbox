import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getViewer } from "@/lib/auth";

export const metadata = { title: "More" };

const links = [
  { href: "/series", label: "Series", detail: "Issues you own" },
  { href: "/boxes", label: "Storage boxes", detail: "Where each copy lives" },
  { href: "/wishlist", label: "Wishlist", detail: "Gaps you still want" },
  { href: "/import", label: "Import CLZ", detail: "Upload a 66-column export" },
  { href: "/covers", label: "Cover backfill", detail: "Download Metron covers and review misses" },
  { href: "/settings", label: "Settings", detail: "Import, covers, pricing, display, and credentials" },
  { href: "/logs", label: "Logs", detail: "Imports, API calls, scans, and errors" },
  { href: "/review", label: "Review matches", detail: "Proposed links waiting for a yes" },
  { href: "/scan", label: "Scan / Add", detail: "Barcode or manual search" },
];

export default async function MorePage() {
  const viewer = await getViewer();
  return (
    <div>
      <PageHeader kicker="More" title="Shelf tools" />
      <ul className="overflow-hidden rounded-2xl bg-panel ring-1 ring-white/5">
        {links.map((link) => (
          <li key={link.href} className="border-b border-white/5 last:border-b-0">
            <Link href={link.href} className="block px-4 py-3 hover:bg-panel2">
              <span className="block font-medium">{link.label}</span>
              <span className="text-sm text-mist">{link.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-mist">
        {viewer.source === "cloudflare-access" ? "Cloudflare Access" : "Single-user mode"} · {viewer.email}
      </p>
    </div>
  );
}
