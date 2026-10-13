import { seriesRouteId, type SeriesIdentity } from "@/lib/series";

export type ShelfComic = SeriesIdentity & {
  id: string;
  issueNo: string | null;
  issueSort: number | null;
  quantity: number;
  keyLevel: string | null;
  rawOrSlabbed: string | null;
  coverUrl: string | null;
  variant: string | null;
  grade: string | null;
  storageBox: string | null;
  read: boolean;
};

export type SeriesCardModel = {
  id: string;
  series: string;
  publisher: string | null;
  count: number;
  copies: number;
  keys: number;
  keyLevel: string | null;
  slabs: number;
  coverUrl: string | null;
  sampleIssue: string | null;
};

export function groupSeries(comics: ShelfComic[]): SeriesCardModel[] {
  const map = new Map<string, SeriesCardModel & { issueSort: number }>();
  for (const comic of comics) {
    const id = seriesRouteId(comic);
    let card = map.get(id);
    if (!card) {
      card = {
        id,
        series: comic.series,
        publisher: comic.publisher,
        count: 0,
        copies: 0,
        keys: 0,
        keyLevel: null,
        slabs: 0,
        coverUrl: comic.coverUrl,
        sampleIssue: comic.issueNo,
        issueSort: comic.issueSort ?? Number.MAX_SAFE_INTEGER,
      };
      map.set(id, card);
    }
    card.count += 1;
    card.copies += comic.quantity;
    if (comic.keyLevel === "Major" || comic.keyLevel === "Minor") {
      card.keys += 1;
      if (comic.keyLevel === "Major" || card.keyLevel !== "Major") card.keyLevel = comic.keyLevel;
    }
    if (comic.rawOrSlabbed === "Slabbed") card.slabs += 1;
    const sort = comic.issueSort ?? Number.MAX_SAFE_INTEGER;
    if (sort < card.issueSort) {
      card.issueSort = sort;
      card.coverUrl = comic.coverUrl;
      card.sampleIssue = comic.issueNo;
    }
  }
  return [...map.values()]
    .sort((a, b) => a.series.localeCompare(b.series))
    .map((card) => ({
      id: card.id,
      series: card.series,
      publisher: card.publisher,
      count: card.count,
      copies: card.copies,
      keys: card.keys,
      keyLevel: card.keyLevel,
      slabs: card.slabs,
      coverUrl: card.coverUrl,
      sampleIssue: card.sampleIssue,
    }));
}
