import Link from "next/link";
import { notFound } from "next/navigation";
import { CoverTile } from "@/components/cover-tile";
import { PageHeader } from "@/components/page-header";
import { addMissingAction } from "@/app/wishlist/actions";
import { prisma } from "@/lib/db";
import { buildRun, seriesRouteId } from "@/lib/series";

export async function generateMetadata({ params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  return { title: decodeURIComponent(seriesId) };
}

export default async function SeriesRunPage({ params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  const decoded = decodeURIComponent(seriesId);
  const all = await prisma.comic.findMany({ orderBy: [{ issueSort: "asc" }, { variant: "asc" }] });
  const comics = all.filter((comic) => comic.coreSeriesId === decoded || seriesRouteId(comic) === decoded);
  if (comics.length === 0) notFound();

  const series = comics[0].series;
  const publisher = comics[0].publisher ?? "";
  const wishlist = await prisma.wishlistItem.findMany({
    where: { series, OR: [{ publisher }, { publisher: "" }] },
  });
  const run = buildRun(
    comics.map((comic) => ({ id: comic.id, issueNo: comic.issueNo, issueSort: comic.issueSort })),
    wishlist.map((item) => item.issueNo),
  );
  const byId = new Map(comics.map((comic) => [comic.id, comic]));

  return (
    <div>
      <PageHeader kicker={publisher || "Series"} title={series}>
        <p className="text-sm text-mist">
          {comics.length} owned
          {run.missing.length > 0 ? ` · ${run.missing.length} missing in this span` : ""}
        </p>
      </PageHeader>
      <p className="mb-4 max-w-2xl text-sm text-mist">
        Filled tiles are issues on the shelf. Dashed tiles are gaps between the lowest and highest issue number you own.
        {run.collapsed ? " This span is too wide to draw every gap, so only owned issues are shown." : ""}
      </p>
      {run.missing.length > 0 ? (
        <form action={addMissingAction} className="mb-5">
          <input type="hidden" name="series" value={series} />
          <input type="hidden" name="publisher" value={publisher} />
          <input type="hidden" name="seriesId" value={decoded} />
          <input type="hidden" name="issues" value={run.missing.join(",")} />
          <button type="submit" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
            Add missing to wishlist
          </button>
        </form>
      ) : null}
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {run.slots.map((slot) => {
          const owned = slot.ownedIds.map((id) => byId.get(id)).filter((comic) => comic != null);
          if (owned.length === 0) {
            return (
              <li key={`missing-${slot.issueNo}`}>
                <div className="missing-slot flex aspect-[2/3] flex-col items-center justify-center rounded-xl border border-dashed border-comic/60 text-center">
                  <span className="font-display text-4xl text-comic">#{slot.issueNo}</span>
                  <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-comic">
                    {slot.wishlisted ? "Wishlist" : "Missing"}
                  </span>
                </div>
              </li>
            );
          }
          const primary = owned[0];
          return (
            <li key={primary.id}>
              <CoverTile
                href={`/issues/${primary.id}`}
                title={primary.series}
                issue={primary.issueNo}
                coverUrl={primary.coverUrl}
                keyLevel={primary.keyLevel}
                slab={primary.rawOrSlabbed === "Slabbed"}
                variant={owned.length > 1 ? `${owned.length} copies` : primary.variant}
              />
              {owned.length > 1 ? (
                <ul className="mt-1 space-y-0.5 text-[11px] text-mist">
                  {owned.map((comic) => (
                    <li key={comic.id}>
                      <Link href={`/issues/${comic.id}`} className="hover:text-comic">
                        {comic.variant || comic.variantDescription || "Copy"}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
