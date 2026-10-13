import { AGE_ORDER, ageBucket } from "@/lib/series";

export type StatsComic = {
  quantity: number;
  series: string;
  publisher: string | null;
  keyLevel: string | null;
  rawOrSlabbed: string | null;
  coverYear: number | null;
  purchasePrice: { toString(): string } | string | null;
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
  ages: Array<{ label: string; count: number }>;
  publisherBars: Array<{ label: string; count: number }>;
  topSeries: Array<{ label: string; count: number; copies: number }>;
};

export function computeStats(comics: StatsComic[]): ShelfStats {
  const series = new Set<string>();
  const publishers = new Set<string>();
  const ageCounts = new Map<string, number>();
  const publisherCounts = new Map<string, number>();
  const seriesCounts = new Map<string, { count: number; copies: number }>();
  let copies = 0;
  let majorKeys = 0;
  let minorKeys = 0;
  let slabs = 0;
  let spend = 0;

  for (const comic of comics) {
    copies += comic.quantity;
    series.add(comic.series);
    if (comic.publisher) publishers.add(comic.publisher);
    if (comic.keyLevel === "Major") majorKeys += 1;
    if (comic.keyLevel === "Minor") minorKeys += 1;
    if (comic.rawOrSlabbed === "Slabbed") slabs += 1;
    if (comic.purchasePrice != null && comic.purchasePrice !== "") {
      const amount = Number(comic.purchasePrice.toString());
      if (Number.isFinite(amount)) spend += amount;
    }
    const bucket = ageBucket(comic.coverYear);
    ageCounts.set(bucket, (ageCounts.get(bucket) ?? 0) + comic.quantity);
    const publisher = comic.publisher ?? "Unknown";
    publisherCounts.set(publisher, (publisherCounts.get(publisher) ?? 0) + comic.quantity);
    const current = seriesCounts.get(comic.series) ?? { count: 0, copies: 0 };
    current.count += 1;
    current.copies += comic.quantity;
    seriesCounts.set(comic.series, current);
  }

  return {
    comics: comics.length,
    copies,
    series: series.size,
    publishers: publishers.size,
    majorKeys,
    minorKeys,
    slabs,
    spend,
    ages: AGE_ORDER.filter((label) => (ageCounts.get(label) ?? 0) > 0).map((label) => ({
      label,
      count: ageCounts.get(label) ?? 0,
    })),
    publisherBars: [...publisherCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 8),
    topSeries: [...seriesCounts.entries()]
      .map(([label, value]) => ({ label, count: value.count, copies: value.copies }))
      .sort((a, b) => b.copies - a.copies || a.label.localeCompare(b.label))
      .slice(0, 8),
  };
}
