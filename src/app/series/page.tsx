import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { groupSeries } from "@/lib/collection";
import { prisma } from "@/lib/db";

export const metadata = { title: "Series" };

export default async function SeriesIndexPage() {
  const comics = await prisma.comic.findMany({
    orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
    select: {
      id: true,
      series: true,
      publisher: true,
      coreSeriesId: true,
      issueNo: true,
      issueSort: true,
      quantity: true,
      keyLevel: true,
      rawOrSlabbed: true,
      coverUrl: true,
      variant: true,
      variantDescription: true,
      grade: true,
      storageBox: true,
      read: true,
    },
  });
  const series = groupSeries(comics);

  return (
    <div>
      <PageHeader kicker="Runs" title="Series" />
      {series.length === 0 ? (
        <p className="text-mist">No series yet.</p>
      ) : (
        <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl bg-panel ring-1 ring-white/5">
          {series.map((card) => (
            <li key={card.id}>
              <Link href={`/series/${encodeURIComponent(card.id)}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-panel2">
                <span>
                  <span className="block font-medium">{card.series}</span>
                  <span className="text-sm text-mist">{card.publisher ?? "Unknown publisher"}</span>
                </span>
                <span className="text-right text-sm text-mist">
                  <span className="block font-display text-3xl leading-none text-paper">{card.copies}</span>
                  {card.keys > 0 ? (
                    <span className="text-comic">{card.keys === 1 ? "1 key" : `${card.keys} keys`}</span>
                  ) : (
                    <span>{card.count === 1 ? "1 comic" : `${card.count} comics`}</span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
