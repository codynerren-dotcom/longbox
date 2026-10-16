import Link from "next/link";
import { ReviewList, type ReviewCard } from "@/app/review/review-list";
import { PageHeader } from "@/components/page-header";
import { catalogIssueHref, catalogViewLabel, isGcdScanHost } from "@/lib/catalog/match-row";
import { coverPublicPath } from "@/lib/covers/backfill";
import { visibleProposals } from "@/lib/covers/propose-match";
import { prisma } from "@/lib/db";
import { formatIssue } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review matches" };

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const provider = one(params.provider) || "all";
  const q = one(params.q);
  let error: string | null = null;
  let pending = 0;
  let cards: ReviewCard[] = [];
  try {
    pending = await prisma.matchProposal.count({ where: { status: "pending" } });
    const rows = await prisma.matchProposal.findMany({
      where: { status: "pending" },
      orderBy: [{ title: "asc" }, { issueNo: "asc" }],
      include: {
        comic: { select: { series: true, issueNo: true, issue: true, variant: true, coverFile: true } },
      },
    });
    const visible = visibleProposals(
      rows.map((row) => ({
        ...row,
        shelf: `${row.comic.series} ${row.comic.issueNo ?? ""} ${row.comic.variant ?? ""}`,
      })),
      { provider, q },
    );
    cards = visible.flatMap((row) => {
      if (row.provider !== "metron" && row.provider !== "comicvine" && row.provider !== "gcd") return [];
      const placeholder = row.provider === "gcd" || isGcdScanHost(row.coverUrl);
      return [
        {
          id: row.id,
          provider: row.provider,
          title: row.title,
          issueNo: row.issueNo,
          variant: row.variant,
          reason: row.reason,
          shelfCover: row.comic.coverFile ? coverPublicPath(row.comic.coverFile) : null,
          shelfLabel: `${row.comic.series} ${formatIssue(row.comic.issueNo ?? row.comic.issue)}`,
          proposedCover: placeholder ? null : row.coverUrl,
          placeholder,
          viewHref: catalogIssueHref(row.provider, row.issueId),
          viewLabel: catalogViewLabel(row.provider),
          comicHref: `/issues/${row.comicId}`,
        },
      ];
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Proposals could not be read.";
  }

  return (
    <div className="max-w-3xl">
      <PageHeader kicker="Catalog" title="Review matches">
        <p className="max-w-sm text-sm text-mist">A proposal is a suggestion. Accept links it. Reject keeps that suggestion from coming back. The copy stays as it is until you accept.</p>
      </PageHeader>
      {error ? <p className="mb-4 text-sm text-red-300">{error}</p> : null}
      <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="review-provider">
          Catalog
        </label>
        <select id="review-provider" name="provider" defaultValue={provider} className="field max-w-40">
          <option value="all">All catalogs</option>
          <option value="metron">Metron</option>
          <option value="gcd">GCD</option>
          <option value="comicvine">Comic Vine</option>
        </select>
        <label className="sr-only" htmlFor="review-q">
          Filter proposals
        </label>
        <input id="review-q" name="q" defaultValue={q} placeholder="Title, issue, variant" className="field max-w-xs" />
        <button type="submit" className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper">
          Filter
        </button>
      </form>
      {cards.length === 0 && !error ? (
        <p className="text-sm text-mist">
          {pending === 0 ? (
            <>
              Nothing waiting. Propose matches from <Link href="/covers" className="text-comic">Covers</Link>, or run <code className="text-paper">npm run covers:propose</code>.
            </>
          ) : (
            "No proposals match this filter."
          )}
        </p>
      ) : (
        <ReviewList cards={cards} />
      )}
    </div>
  );
}
