import Link from "next/link";
import { CoverTile } from "@/components/cover-tile";
import { paletteFor } from "@/lib/visual";
import type { SeriesRow } from "@/lib/series-view";

export type DisplayRow = SeriesRow & { date?: string; image?: string | null };

export function SeriesList({ series, rows }: { series: string; rows: DisplayRow[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.comic.id}>
          <Link
            href={`/issues/${row.comic.id}`}
            className="flex items-center gap-3 rounded-2xl bg-panel/85 px-3 py-2 ring-1 ring-white/5 hover:ring-comic/40"
          >
            <Thumb title={series} image={row.image ?? null} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-paper">{series}</span>
                {row.key ? <KeyBadge /> : null}
              </span>
              {row.description ? <span className="mt-0.5 block truncate text-sm text-mist">{row.description}</span> : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="flex flex-col items-end">
                <IssueBadge badge={row.badge} />
                {row.date ? <span className="mt-1 text-[11px] text-mist">{row.date}</span> : null}
              </span>
              <OwnedMark read={row.comic.read} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SeriesGrid({ series, rows }: { series: string; rows: DisplayRow[] }) {
  return (
    <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
      {rows.map((row) => (
        <li key={row.comic.id} className="min-w-0 overflow-hidden">
          <CoverTile
            href={`/issues/${row.comic.id}`}
            title={series}
            issue={row.badge.replace(/^#/, "")}
            coverUrl={row.comic.coverUrl}
            keyLevel={row.comic.keyLevel}
            slab={row.comic.rawOrSlabbed === "Slabbed"}
          />
          <p className="mt-1 truncate text-xs font-semibold text-paper">{row.badge}</p>
          <p className="truncate text-[11px] text-mist" title={row.description ?? undefined}>
            {row.description || (row.letter ? `Cover ${row.letter}` : "\u00a0")}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Thumb({ title, image }: { title: string; image: string | null }) {
  const [from, to] = paletteFor(title);
  return (
    <span className="relative h-[4.5rem] w-12 shrink-0 overflow-hidden rounded-md bg-panel2">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0" style={{ background: `linear-gradient(165deg, ${from}, ${to} 70%)` }} />
      )}
    </span>
  );
}

function IssueBadge({ badge }: { badge: string }) {
  return (
    <span className="rounded-md border border-paper/40 px-1.5 py-0.5 text-xs font-semibold tracking-wide text-paper">{badge}</span>
  );
}

function KeyBadge() {
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-comic/15 text-comic"
      title="Key issue"
      aria-label="Key issue"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
        <path d="M7.2 1.2a3.3 3.3 0 0 0-1.55 6.2l-.08.7-1.32 1.32-1.15-.9-1.05 1.05 1.15 1.15-1.2 1.2 1.05 1.05 1.2-1.2.95.75 1.35-1.35.72-.08A3.3 3.3 0 1 0 7.2 1.2Zm.15 1.7a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z" />
      </svg>
    </span>
  );
}

function OwnedMark({ read }: { read: boolean }) {
  return (
    <span aria-label={read ? "Read" : "Owned"} title={read ? "Read" : "Owned"} className={read ? "text-comic" : "text-mist"}>
      {read ? (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
          <path d="M8 1.2a6.8 6.8 0 1 0 0 13.6A6.8 6.8 0 0 0 8 1.2Zm3.15 4.55-3.7 4.4a.7.7 0 0 1-1.05.05L4.7 8.35a.7.7 0 1 1 1.05-.92l1.15 1.3 3.2-3.8a.7.7 0 0 1 1.05.82Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="8" cy="8" r="6.1" />
          <path d="M4.8 8.2 7 10.4 11.3 5.8" />
        </svg>
      )}
    </span>
  );
}
