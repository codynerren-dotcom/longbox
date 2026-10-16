import { costBasis } from "@/lib/clz/parse";
import { AGE_ORDER, ageBucket } from "@/lib/series";
import { baseIssueKey, baseIssueLabel, countBaseIssues } from "@/lib/series-view";
import { isCollected, shelfFormatOf } from "@/lib/shelf-format";

export type StatsComic = {
  quantity: number;
  series: string;
  issueNo?: string | null;
  publisher: string | null;
  keyLevel: string | null;
  rawOrSlabbed: string | null;
  coverYear: number | null;
  purchasePrice: { toString(): string } | string | null;
  shelfFormat?: string | null;
};

export type ShelfStats = {
  comics: number;
  copies: number;
  series: number;
  publishers: number;
  majorKeys: number;
  minorKeys: number;
  slabs: number;
  spend: number;
  singles: number;
  trades: number;
  singleSpend: number;
  tradeSpend: number;
  ages: Array<{ label: string; count: number }>;
  publisherBars: Array<{ label: string; count: number }>;
  topSeries: Array<{ label: string; count: number; copies: number }>;
};

/** Dashboard top-series line. Same words as a series header: comic, and a copies clause. */
export function topSeriesLabel(count: number, copies: number): string {
  const comics = count === 1 ? "1 comic" : `${count} comics`;
  const copyLabel = copies === 1 ? "1 copy" : `${copies} copies`;
  return `${comics} · ${copyLabel}`;
}

export function computeStats(comics: StatsComic[]): ShelfStats {
  const series = new Set<string>();
  const publishers = new Set<string>();
  const ageCounts = new Map<string, number>();
  const publisherCounts = new Map<string, number>();
  const seriesCounts = new Map<string, { bases: Set<string>; blank: number; copies: number }>();
  let copies = 0;
  let majorKeys = 0;
  let minorKeys = 0;
  let slabs = 0;
  let spendCents = 0;
  let singles = 0;
  let trades = 0;
  let singleCents = 0;
  let tradeCents = 0;

  for (const comic of comics) {
    copies += comic.quantity;
    series.add(comic.series);
    if (comic.publisher) publishers.add(comic.publisher);
    if (comic.keyLevel === "Major") majorKeys += 1;
    if (comic.keyLevel === "Minor") minorKeys += 1;
    if (comic.rawOrSlabbed === "Slabbed") slabs += 1;
    const line = costBasis(comic.purchasePrice, comic.quantity);
    const cents = line ? Number(line.replace(".", "")) : 0;
    if (line) spendCents += cents;
    if (isCollected(shelfFormatOf(comic.shelfFormat))) {
      trades += 1;
      tradeCents += cents;
    } else {
      singles += 1;
      singleCents += cents;
    }
    const bucket = ageBucket(comic.coverYear);
    ageCounts.set(bucket, (ageCounts.get(bucket) ?? 0) + comic.quantity);
    const publisher = comic.publisher ?? "Unknown";
    publisherCounts.set(publisher, (publisherCounts.get(publisher) ?? 0) + comic.quantity);
    const current = seriesCounts.get(comic.series) ?? { bases: new Set<string>(), blank: 0, copies: 0 };
    const unlabeled = baseIssueLabel(comic.issueNo ?? "") == null;
    current.bases.add(baseIssueKey({ series: comic.series, issueNo: comic.issueNo ?? null }, `blank-${current.blank}`));
    if (unlabeled) current.blank += 1;
    current.copies += comic.quantity;
    seriesCounts.set(comic.series, current);
  }

  return {
    comics: countBaseIssues(comics.map((comic, index) => ({ series: comic.series, issueNo: comic.issueNo ?? null, id: `row-${index}` }))),
    copies,
    series: series.size,
    publishers: publishers.size,
    majorKeys,
    minorKeys,
    slabs,
    spend: spendCents / 100,
    singles,
    trades,
    singleSpend: singleCents / 100,
    tradeSpend: tradeCents / 100,
    ages: AGE_ORDER.filter((label) => (ageCounts.get(label) ?? 0) > 0).map((label) => ({
      label,
      count: ageCounts.get(label) ?? 0,
    })),
    publisherBars: [...publisherCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 8),
    topSeries: [...seriesCounts.entries()]
      .map(([label, value]) => ({ label, count: value.bases.size, copies: value.copies }))
      .sort((a, b) => b.copies - a.copies || a.label.localeCompare(b.label))
      .slice(0, 8),
  };
}
