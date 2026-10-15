import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { CoverTile } from "@/components/cover-tile";
import { FilterBar } from "@/components/filter-bar";
import { PageHeader } from "@/components/page-header";
import { groupSeries, orderSeriesCards, seriesCardCountLabel, seriesOrderHints } from "@/lib/collection";
import { prisma } from "@/lib/db";
import { one } from "@/lib/format";
import { copyCountLabel } from "@/lib/series-view";
import { collectionGridClass } from "@/lib/settings/preferences";
import { getPreferences } from "@/lib/settings/service";

export const metadata = { title: "Collection" };

export default async function CollectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = one(params.q).trim();
  const keys = one(params.keys) === "1";
  const slabs = one(params.slabs) === "1";
  const read = one(params.read);
  const publisher = one(params.publisher);
  const box = one(params.box);
  const prefs = await getPreferences();

  const where: Prisma.ComicWhereInput = {};
  const and: Prisma.ComicWhereInput[] = [];
  if (q) {
    and.push({
      OR: [
        { series: { contains: q, mode: "insensitive" } },
        { publisher: { contains: q, mode: "insensitive" } },
        { title: { contains: q, mode: "insensitive" } },
        { barcode: { contains: q } },
        { issueNo: { contains: q } },
        { storageBox: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (keys) and.push({ keyLevel: { in: ["Major", "Minor"] } });
  if (slabs) and.push({ rawOrSlabbed: "Slabbed" });
  if (read === "read") and.push({ read: true });
  if (read === "unread") and.push({ read: false });
  if (publisher) and.push({ publisher });
  if (box) and.push({ storageBox: box });
  if (!prefs.collection.showSold) and.push({ soldDate: null });
  if (and.length > 0) where.AND = and;

  const [comics, publisherRows, boxRows] = await Promise.all([
    prisma.comic.findMany({
      where,
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
        addedDate: true,
        coverYear: true,
      },
    }),
    prisma.comic.findMany({
      where: { publisher: { not: null } },
      distinct: ["publisher"],
      select: { publisher: true },
      orderBy: { publisher: "asc" },
    }),
    prisma.comic.findMany({
      where: { storageBox: { not: null } },
      distinct: ["storageBox"],
      select: { storageBox: true },
      orderBy: { storageBox: "asc" },
    }),
  ]);

  const series = orderSeriesCards(groupSeries(comics), seriesOrderHints(comics), prefs.collection.sort);

  return (
    <div>
      <PageHeader kicker="Library" title="Collection">
        <p className="text-sm text-mist">
          {series.length === 1 ? "1 series" : `${series.length} series`} · {copyCountLabel(comics)}
        </p>
      </PageHeader>
      <FilterBar
        q={q}
        keys={keys}
        slabs={slabs}
        read={read}
        publisher={publisher}
        box={box}
        publishers={publisherRows.map((row) => row.publisher).filter((name): name is string => Boolean(name))}
        boxes={boxRows.map((row) => row.storageBox).filter((name): name is string => Boolean(name))}
      />
      {series.length === 0 ? (
        <p className="rounded-2xl bg-panel px-4 py-8 text-center text-mist">
          No comics match. <Link href="/import" className="text-comic">Import a CLZ CSV</Link> or{" "}
          <Link href="/scan" className="text-comic">scan a barcode</Link>.
        </p>
      ) : (
        <ul className={collectionGridClass(prefs.collection.density)}>
          {series.map((card) => (
            <li key={card.id}>
              <CoverTile
                href={`/series/${encodeURIComponent(card.id)}`}
                title={card.series}
                issue={card.sampleIssue}
                coverUrl={card.coverUrl}
                keyLevel={card.keyLevel}
                slab={card.slabs > 0}
              />
              <div className="mt-2">
                <Link href={`/series/${encodeURIComponent(card.id)}`} className="line-clamp-2 font-medium leading-tight hover:text-comic">
                  {card.series}
                </Link>
                <p className="mt-1 text-xs text-mist">
                  {card.publisher ?? "Unknown publisher"} · {seriesCardCountLabel(card)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
