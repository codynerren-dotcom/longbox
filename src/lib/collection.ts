import type { CollectionSort } from "@/lib/settings/preferences";
import { seriesRouteId, type SeriesIdentity } from "@/lib/series";
import { baseIssueKey, copyGroupKey, copyQuantity } from "@/lib/series-view";
import { seriesHeaderFormat } from "@/lib/shelf-format";

export type ShelfComic = SeriesIdentity & {
  id: string;
  issueNo: string | null;
  issueSort: number | null;
  quantity: number;
  keyLevel: string | null;
  rawOrSlabbed: string | null;
  coverUrl: string | null;
  variant: string | null;
  variantDescription?: string | null;
  grade: string | null;
  storageBox: string | null;
  read: boolean;
  shelfFormat?: string | null;
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
  shelfFormat: string | null;
};

export function seriesCardCountLabel(card: Pick<SeriesCardModel, "count" | "copies">): string {
  const comics = card.count === 1 ? "1 comic" : `${card.count} comics`;
  if (card.copies === card.count) return comics;
  const copies = card.copies === 1 ? "1 copy" : `${card.copies} copies`;
  return `${comics} · ${copies}`;
}

export function groupSeries(comics: ShelfComic[]): SeriesCardModel[] {
  const map = new Map<string, SeriesCardModel & { issueSort: number; coverSort: number; seen: Set<string>; keyed: Set<string>; formats: Array<string | null | undefined> }>();
  for (const comic of comics) {
    const id = seriesRouteId(comic);
    const sort = comic.issueSort ?? Number.MAX_SAFE_INTEGER;
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
        shelfFormat: null,
        issueSort: sort,
        coverSort: comic.coverUrl ? sort : Number.MAX_SAFE_INTEGER,
        seen: new Set<string>(),
        keyed: new Set<string>(),
        formats: [],
      };
      map.set(id, card);
    }
    const identity = copyGroupKey({
      series: comic.series,
      issueNo: comic.issueNo,
      variant: comic.variant,
      variantDescription: comic.variantDescription,
      quantity: comic.quantity,
    });
    const base = baseIssueKey(comic, comic.id);
    if (!card.seen.has(base)) {
      card.seen.add(base);
      card.count += 1;
    }
    card.copies += copyQuantity(comic);
    card.formats.push(comic.shelfFormat);
    if (comic.keyLevel === "Major" || comic.keyLevel === "Minor") {
      if (!card.keyed.has(identity)) {
        card.keyed.add(identity);
        card.keys += 1;
      }
      if (comic.keyLevel === "Major" || card.keyLevel !== "Major") card.keyLevel = comic.keyLevel;
    }
    if (comic.rawOrSlabbed === "Slabbed") card.slabs += 1;
    if (sort < card.issueSort) {
      card.issueSort = sort;
      if (!card.coverUrl) card.sampleIssue = comic.issueNo;
    }
    if (comic.coverUrl && sort <= card.coverSort) {
      card.coverUrl = comic.coverUrl;
      card.coverSort = sort;
      card.sampleIssue = comic.issueNo;
    }
  }
  return sortedSeriesCards([...map.values()]);
}

export function seriesOrderHints(
  comics: Array<SeriesIdentity & { addedDate: Date | null; coverYear: number | null }>,
): Map<string, { addedAt: number; coverYear: number }> {
  const hints = new Map<string, { addedAt: number; coverYear: number }>();
  for (const comic of comics) {
    const id = seriesRouteId(comic);
    const current = hints.get(id) ?? { addedAt: 0, coverYear: 0 };
    const added = comic.addedDate?.getTime() ?? 0;
    if (added > current.addedAt) current.addedAt = added;
    if ((comic.coverYear ?? 0) > current.coverYear) current.coverYear = comic.coverYear ?? current.coverYear;
    hints.set(id, current);
  }
  return hints;
}

export function orderSeriesCards<T extends { id: string; series: string; publisher: string | null }>(
  cards: T[],
  hints: ReadonlyMap<string, { addedAt: number; coverYear: number }>,
  sort: CollectionSort,
): T[] {
  const copy = [...cards];
  copy.sort((a, b) => {
    if (sort === "publisher") return (a.publisher ?? "").localeCompare(b.publisher ?? "") || a.series.localeCompare(b.series);
    if (sort === "added") return (hints.get(b.id)?.addedAt ?? 0) - (hints.get(a.id)?.addedAt ?? 0) || a.series.localeCompare(b.series);
    if (sort === "coverYear") return (hints.get(b.id)?.coverYear ?? 0) - (hints.get(a.id)?.coverYear ?? 0) || a.series.localeCompare(b.series);
    return a.series.localeCompare(b.series);
  });
  return copy;
}

function sortedSeriesCards(
  cards: Array<SeriesCardModel & { issueSort: number; coverSort: number; formats: Array<string | null | undefined> }>,
): SeriesCardModel[] {
  return [...cards]
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
      shelfFormat: seriesHeaderFormat(card.formats),
    }));
}
