import { notFound } from "next/navigation";
import { AddSeriesIssue } from "@/app/series/add-issue";
import { SeriesGrid, SeriesList, type DisplayRow } from "@/app/series/series-rows";
import { SeriesShelf } from "@/app/series/series-shelf";
import { addMissingAction } from "@/app/wishlist/actions";
import { SeriesCatalogLinks } from "@/components/catalog-links";
import { prisma } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { seriesRouteId } from "@/lib/series";
import {
  buildSeriesRows,
  copyCountLabel,
  haveRange,
  majorityPublisher,
  ownedIssueCount,
  seriesSpend,
  yearSpan,
  type SeriesCopy,
} from "@/lib/series-view";
import { dateOptions } from "@/lib/settings/preferences";
import { getPreferences } from "@/lib/settings/service";
import { safeImageUrl } from "@/lib/url";

export async function generateMetadata({ params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  const comics = await loadSeriesComics(decodeURIComponent(seriesId));
  return { title: comics[0]?.series ?? "Series" };
}

export default async function SeriesRunPage({ params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  const decoded = decodeURIComponent(seriesId);
  const [loaded, prefs] = await Promise.all([loadSeriesComics(decoded), getPreferences()]);
  if (loaded.length === 0) notFound();

  const comics = loaded.map(toCopy);
  const series = comics[0].series;
  const publisher = majorityPublisher(comics);
  const wishlist = await prisma.wishlistItem.findMany({
    where: { series, OR: [{ publisher }, { publisher: "" }] },
  });
  const run = buildSeriesRows(
    comics,
    wishlist.map((item) => item.issueNo),
  );
  const when = dateOptions(prefs);
  const rows: DisplayRow[] = run.rows.map((row) => {
    if (row.kind === "missing") return row;
    const release = row.comic.releaseDate ? formatDate(row.comic.releaseDate, when) : "";
    return {
      ...row,
      date: release && release !== "—" ? release : row.comic.coverDate?.trim() || "",
      image: safeImageUrl(row.comic.coverUrl),
    };
  });
  const backdrop = rows.find((row) => row.kind === "owned" && row.image)?.image ?? null;
  const spend = seriesSpend(comics);
  const years = yearSpan(comics);
  const have = haveRange(comics);
  const owned = ownedIssueCount(comics);
  const coreSeriesId = loaded.find((comic) => comic.coreSeriesId)?.coreSeriesId ?? decoded;

  return (
    <div className="relative isolate">
      {backdrop ? (
        <div className="pointer-events-none absolute -inset-x-4 -top-5 bottom-0 -z-10 overflow-hidden md:-inset-x-8 md:-top-8" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={backdrop} alt="" className="h-72 w-full scale-110 object-cover opacity-30 blur-2xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-ink/55 via-ink/80 to-ink" />
        </div>
      ) : null}
      <header className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-comic">{publisher || "Series"}</p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="min-w-0 flex-1 font-display text-5xl tracking-wide text-paper sm:text-6xl">{series}</h1>
          <AddSeriesIssue series={series} publisher={publisher} seriesId={decoded} coreSeriesId={coreSeriesId} />
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-2xl bg-panel/75 px-4 py-3 text-sm ring-1 ring-white/5">
          <span className="font-semibold text-paper">{copyCountLabel(comics)}</span>
          {have ? <span className="text-mist">{have}</span> : null}
        </div>
        <p className="mt-2 text-sm text-mist">
          {[
            years,
            `${owned} owned`,
            run.missing.length > 0 ? `${run.missing.length} missing` : null,
            spend ? `Cost basis ${formatMoney(spend, prefs.pricing.currency)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <SeriesCatalogLinks comics={loaded} />
      </header>
      {run.collapsed ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="max-w-xl text-sm text-mist">
            This span is too wide to list every gap. Owned issues are shown, and the missing count is in the header.
          </p>
          {run.missing.length > 0 ? (
            <form action={addMissingAction}>
              <input type="hidden" name="series" value={series} />
              <input type="hidden" name="publisher" value={publisher} />
              <input type="hidden" name="seriesId" value={decoded} />
              <input type="hidden" name="issues" value={run.missing.join(",")} />
              <button type="submit" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
                Add missing to wishlist
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      <SeriesShelf
        list={<SeriesList series={series} publisher={publisher} seriesId={decoded} rows={rows} />}
        grid={<SeriesGrid series={series} publisher={publisher} seriesId={decoded} rows={rows} />}
      />
    </div>
  );
}

async function loadSeriesComics(decoded: string) {
  const byCore = await prisma.comic.findMany({
    where: { coreSeriesId: decoded },
    orderBy: [{ issueSort: "asc" }, { variant: "asc" }, { id: "asc" }],
  });
  if (byCore.length > 0) return byCore;
  const all = await prisma.comic.findMany({
    orderBy: [{ issueSort: "asc" }, { variant: "asc" }, { id: "asc" }],
  });
  return all.filter((comic) => seriesRouteId(comic) === decoded);
}

function toCopy(comic: Awaited<ReturnType<typeof loadSeriesComics>>[number]): SeriesCopy {
  return {
    id: comic.id,
    series: comic.series,
    publisher: comic.publisher,
    issueNo: comic.issueNo,
    variant: comic.variant,
    variantDescription: comic.variantDescription,
    releaseDate: comic.releaseDate,
    coverDate: comic.coverDate,
    coverYear: comic.coverYear,
    releaseYear: comic.releaseYear,
    seriesYear: comic.seriesYear,
    coverUrl: comic.coverUrl,
    keyLevel: comic.keyLevel,
    rawOrSlabbed: comic.rawOrSlabbed,
    read: comic.read,
    quantity: comic.quantity,
    purchasePrice: comic.purchasePrice,
  };
}
