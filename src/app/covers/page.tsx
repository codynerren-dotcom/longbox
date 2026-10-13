import Link from "next/link";
import { AttachForm } from "@/app/covers/attach-form";
import { retryCoverAction } from "@/app/covers/actions";
import { BackfillButton } from "@/app/covers/backfill-button";
import { PageHeader } from "@/components/page-header";
import { readBackfillStatus } from "@/lib/covers/files";
import { metronBasicAuth } from "@/lib/covers/metron-client";
import { prisma } from "@/lib/db";
import { formatIssue } from "@/lib/format";

export const metadata = { title: "Covers" };

export default async function CoversPage() {
  const [matched, pending, unmatched, status] = await Promise.all([
    prisma.comic.count({ where: { coverStatus: "matched" } }),
    prisma.comic.count({
      where: { coverFile: null, OR: [{ coverStatus: null }, { coverStatus: "matched" }] },
    }),
    prisma.comic.findMany({
      where: { coverStatus: "unmatched" },
      orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
      select: {
        id: true,
        series: true,
        issueNo: true,
        publisher: true,
        barcode: true,
        coverYear: true,
        coverNote: true,
        variant: true,
      },
    }),
    Promise.resolve(readBackfillStatus()),
  ]);
  const configured = Boolean(metronBasicAuth());

  return (
    <div className="max-w-3xl">
      {status?.running ? <meta httpEquiv="refresh" content="5" /> : null}
      <PageHeader kicker="Metron" title="Covers" />
      <p className="mb-4 text-sm leading-relaxed text-mist">
        Backfill downloads a cover for every issue that does not have one yet. It tries the barcode first, then the series name, issue number, and cover year. Files land in the <code className="text-paper">longbox_covers</code> volume and the app serves them. Issues Metron cannot match stay on this page.
      </p>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Count label="Matched" value={matched} />
        <Count label="Still need a cover" value={pending} />
        <Count label="Unmatched" value={unmatched.length} />
      </div>
      <section className="rounded-2xl bg-panel p-5 ring-1 ring-white/5">
        <BackfillButton />
        {!configured ? (
          <p className="mt-3 text-sm text-mist">Metron basic auth is not set. Add METRON_USERNAME and METRON_PASSWORD, then run the backfill.</p>
        ) : null}
        {status?.message ? <p className="mt-3 text-sm text-paper">{status.message}</p> : null}
        {status?.running ? <p className="mt-2 text-sm text-mist">Running. This page refreshes every few seconds.</p> : null}
        <p className="mt-3 text-sm text-mist">
          From the shell: <code className="text-paper">npm run covers:backfill</code>
        </p>
      </section>
      <section className="mt-6">
        <h2 className="font-display text-3xl tracking-wide">Unmatched</h2>
        {unmatched.length === 0 ? (
          <p className="mt-2 text-sm text-mist">Nothing waiting for a hand fix.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {unmatched.map((comic) => (
              <li key={comic.id} className="rounded-2xl bg-panel p-4 ring-1 ring-white/5">
                <Link href={`/issues/${comic.id}`} className="font-medium hover:text-comic">
                  {comic.series} {formatIssue(comic.issueNo)}
                </Link>
                <p className="mt-1 text-sm text-mist">
                  {[comic.publisher, comic.coverYear ? String(comic.coverYear) : null, comic.variant, comic.barcode].filter(Boolean).join(" · ") || "No barcode"}
                </p>
                <p className="mt-2 text-sm text-paper">{comic.coverNote}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <form action={retryCoverAction}>
                    <input type="hidden" name="id" value={comic.id} />
                    <button type="submit" className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper">
                      Try again
                    </button>
                  </form>
                </div>
                <AttachForm comicId={comic.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-panel px-4 py-3 ring-1 ring-white/5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-mist">{label}</p>
      <p className="font-display text-4xl tracking-wide text-paper">{value}</p>
    </div>
  );
}
