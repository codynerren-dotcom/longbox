import { notFound } from "next/navigation";
import { AddSeriesIssue } from "@/app/series/add-issue";
import { SeriesGrid, SeriesList, type DisplayRow } from "@/app/series/series-rows";
import { SeriesShelf } from "@/app/series/series-shelf";
import { SeriesSummary } from "@/app/series/series-summary";
import { SeriesCatalogLinks } from "@/components/catalog-links";
import { FormatBadge } from "@/components/format-badge";
import { prisma } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { seriesRouteId } from "@/lib/series";
import { resolveSeriesRun, seriesRunIdentity } from "@/lib/series-run";
import {
  buildSeriesRows,
  copyCountLabel,
  haveRange,
  majorityPublisher,
  ownedIssueCount,
  seriesMissing,
  groupRowFacts,
  seriesSpend,
  yearSpan,
  type SeriesCopy,
} from "@/lib/series-view";
import { detectShelfFormat, seriesHeaderFormat } from "@/lib/shelf-format";
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
  const when = dateOptions(prefs);
  const rows: DisplayRow[] = buildSeriesRows(comics).map((row) => {
    const release = row.comic.releaseDate ? formatDate(row.comic.releaseDate, when) : "";
    return {
      ...row,
      date: release && release !== "—" ? release : row.comic.coverDate?.trim() || "",
      image: safeImageUrl(row.comic.coverUrl),
      facts: groupRowFacts(row.copies, prefs.pricing.currency),
    };
  });
  const backdrop = rows.find((row) => row.kind === "owned" && row.image)?.image ?? null;
  const spend = seriesSpend(comics);
  const years = yearSpan(comics);
  const have = haveRange(comics);
  const missing = seriesMissing(comics, await loadSeriesRun(loaded));
  const owned = ownedIssueCount(comics);
  const coreSeriesId = loaded.find((comic) => comic.coreSeriesId)?.coreSeriesId ?? decoded;

  return (
    <div className="relative isolate overflow-x-hidden">
      {backdrop ? (
        <div className="pointer-events-none absolute -inset-x-4 -top-5 bottom-0 -z-10 overflow-hidden md:-inset-x-8 md:-top-8" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={backdrop} alt="" className="h-96 w-full scale-125 object-cover opacity-70 blur-3xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-ink/15 via-ink/72 to-ink" />
        </div>
      ) : null}
      <header className="mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-comic">{publisher || "Series"}</p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="flex min-w-0 flex-1 flex-wrap items-center gap-3 font-display text-5xl tracking-wide text-paper sm:text-6xl">
            <span>{series}</span>
            <FormatBadge format={seriesHeaderFormat(comics.map((comic) => comic.shelfFormat))} className="font-sans tracking-wide" />
          </h1>
          <AddSeriesIssue
            series={series}
            publisher={publisher}
            seriesId={decoded}
            coreSeriesId={coreSeriesId}
            defaultFormat={detectShelfFormat({ series })}
          />
        </div>
        <SeriesSummary copies={copyCountLabel(comics)} have={have} missing={missing} />
        <p className="mt-2 text-sm text-mist">
          {[years, `${owned} owned`, spend ? `Cost basis ${formatMoney(spend, prefs.pricing.currency)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <SeriesCatalogLinks comics={loaded} />
      </header>
      <SeriesShelf list={<SeriesList series={series} rows={rows} />} grid={<SeriesGrid series={series} rows={rows} />} />
    </div>
  );
}

const seriesQuery = {
  orderBy: [{ issueSort: "asc" as const }, { variant: "asc" as const }, { id: "asc" as const }],
  include: {
    priceSnapshots: {
      where: { amount: { not: null } },
      orderBy: { fetchedAt: "desc" as const },
      take: 1,
    },
  },
};

async function loadSeriesRun(comics: Awaited<ReturnType<typeof loadSeriesComics>>) {
  try {
    return await resolveSeriesRun(seriesRunIdentity(comics));
  } catch {
    return null;
  }
}

async function loadSeriesComics(decoded: string) {
  const byCore = await prisma.comic.findMany({ where: { coreSeriesId: decoded }, ...seriesQuery });
  if (byCore.length > 0) return byCore;
  const all = await prisma.comic.findMany(seriesQuery);
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
    keyReason: comic.keyReason,
    title: comic.title,
    storyArc: comic.storyArc,
    writer: comic.writer,
    coverArtist: comic.coverArtist,
    grade: comic.grade,
    gradingCompany: comic.gradingCompany,
    rawOrSlabbed: comic.rawOrSlabbed,
    storageBox: comic.storageBox,
    signedBy: comic.signedBy,
    read: comic.read,
    quantity: comic.quantity,
    purchasePrice: comic.purchasePrice,
    value: comic.value,
    myValue: comic.myValue,
    priceQuote: comic.priceSnapshots[0]
      ? { amount: comic.priceSnapshots[0].amount, currency: comic.priceSnapshots[0].currency }
      : null,
    shelfFormat: comic.shelfFormat,
  };
}
