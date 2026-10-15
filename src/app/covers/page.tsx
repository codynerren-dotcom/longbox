import Link from "next/link";
import { AttachForm } from "@/app/covers/attach-form";
import { retryCoverAction } from "@/app/covers/actions";
import { BackfillButton } from "@/app/covers/backfill-button";
import { RematchAllSuspects, SuspectActions } from "@/app/covers/suspect-actions";
import { CoverLiveStatus } from "@/components/backfill-status";
import { CatalogIdLink } from "@/components/catalog-id-link";
import { PageHeader } from "@/components/page-header";
import { readManualLink } from "@/lib/catalog/manual-link";
import { suspectMatchReason } from "@/lib/covers/edition";
import { readCatalogYears } from "@/lib/covers/facsimile-rematch";
import { metronBasicAuth } from "@/lib/covers/metron-client";
import { prisma } from "@/lib/db";
import { formatIssue } from "@/lib/format";

export const metadata = { title: "Covers" };

export default async function CoversPage() {
  const [matched, pending, unmatched, linked, configuredAuth, years] = await Promise.all([
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
    prisma.comic.findMany({
      where: { OR: [{ metronIssueId: { not: null } }, { gcdIssueId: { not: null } }] },
      orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
      select: {
        id: true,
        series: true,
        issueNo: true,
        title: true,
        fullTitle: true,
        variant: true,
        variantDescription: true,
        format: true,
        barcode: true,
        subtitle: true,
        publisher: true,
        coverYear: true,
        releaseYear: true,
        releaseDate: true,
        seriesYear: true,
        coverPrice: true,
        metronIssueId: true,
        metronIssueUrl: true,
        gcdIssueId: true,
        manualLink: true,
      },
    }),
    metronBasicAuth(),
    readCatalogYears(),
  ]);
  const suspects = linked.flatMap((comic) => {
    const reason = suspectMatchReason({ ...comic, catalogStoreYear: years[comic.id] ?? null });
    if (!reason) return [];
    const link = readManualLink(comic.manualLink);
    const manual = Boolean((comic.metronIssueId && link.metronIssueId) || (comic.gcdIssueId && link.gcdIssueId));
    return [{ ...comic, reason, manual }];
  });
  const configured = Boolean(configuredAuth);

  return (
    <div className="max-w-3xl">
      <PageHeader kicker="Metron" title="Covers" />
      <p className="mb-4 text-sm leading-relaxed text-mist">
        Backfill downloads a cover for every issue that does not have one yet. It tries the barcode first, then the series name, issue number, and release year. A facsimile copy is matched by its UPC and by a facsimile series, and it is never linked to the original issue. A reprint, later printing, anniversary, True Believers, or omnibus copy is searched as its own series before the original. A match has to clear a confidence score or it stays here for the Match panel. When Metron is not confident, GCD is the fallback. GCD cover scans stay on comics.org.
      </p>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Count label="Matched" value={matched} />
        <Count label="Still need a cover" value={pending} />
        <Count label="Unmatched" value={unmatched.length} />
      </div>
      <section className="rounded-2xl bg-panel p-5 ring-1 ring-white/5">
        <BackfillButton />
        {!configured ? (
          <p className="mt-3 text-sm text-mist">Metron username and password are not set. Add them in Settings, then run the backfill.</p>
        ) : null}
        <div className="mt-3">
          <CoverLiveStatus />
        </div>
        <p className="mt-3 text-sm text-mist">
          From the shell: <code className="text-paper">npm run covers:backfill</code>
        </p>
      </section>
      <section id="suspects" className="mt-6">
        <h2 className="font-display text-3xl tracking-wide">Review suspect matches</h2>
        <p className="mt-2 text-sm text-mist">
          A facsimile link is listed when the linked issue&apos;s store year is not within a year of the copy&apos;s release date. Other links are listed when the copy is another edition, or when its release year and cover year are more than two years apart. Re-match looks the facsimile up again and leaves it unmatched when nothing is confident.
        </p>
        {suspects.length > 0 ? <RematchAllSuspects /> : null}
        {suspects.length === 0 ? (
          <p className="mt-2 text-sm text-mist">No suspect links.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {suspects.map((comic) => (
              <li key={comic.id} className="rounded-2xl bg-panel p-4 ring-1 ring-white/5">
                <Link href={`/issues/${comic.id}`} className="font-medium hover:text-comic">
                  {comic.series} {formatIssue(comic.issueNo)}
                </Link>
                <p className="mt-1 text-sm text-mist">
                  {comic.publisher ? <span>{comic.publisher}</span> : null}
                  {comic.metronIssueId ? (
                    <>
                      {comic.publisher ? " · " : null}
                      Metron <CatalogIdLink kind="metron-issue" id={comic.metronIssueId} siteUrl={comic.metronIssueUrl} />
                    </>
                  ) : null}
                  {comic.gcdIssueId ? (
                    <>
                      {comic.publisher || comic.metronIssueId ? " · " : null}
                      GCD <CatalogIdLink kind="gcd-issue" id={comic.gcdIssueId} />
                    </>
                  ) : null}
                </p>
                <p className="mt-2 text-sm text-paper">{comic.reason}</p>
                {comic.variantDescription ? <p className="mt-1 text-sm text-mist">{comic.variantDescription}</p> : null}
                <SuspectActions id={comic.id} manual={comic.manual} />
              </li>
            ))}
          </ul>
        )}
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
