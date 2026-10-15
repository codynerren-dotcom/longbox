import { issueNumberValue } from "@/lib/clz/parse";

export const DEMO_CORE_ID_MIN = 900001;
export const DEMO_CORE_ID_MAX = 900030;

export const DEMO_WISHLIST = [
  { series: "Saga", publisher: "Image", issueNo: "4", notes: "Gap in the run" },
  { series: "The Walking Dead", publisher: "Image", issueNo: "4", notes: "Gap in the run" },
] as const;

export type DedupeComic = {
  id: string;
  series: string;
  issue: string | null;
  variant: string | null;
  barcode: string | null;
};

export function isDemoCoreId(value: string | null | undefined): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  const id = Number(value);
  return id >= DEMO_CORE_ID_MIN && id <= DEMO_CORE_ID_MAX;
}

export function duplicateGroups(comics: DedupeComic[]): DedupeComic[][] {
  const groups = new Map<string, DedupeComic[]>();
  for (const comic of comics) {
    const barcode = comic.barcode?.trim() ?? "";
    const key = barcode
      ? `barcode:${barcode}`
      : `copy:${comic.series.trim().toLowerCase()}|${(comic.issue ?? "").trim().toLowerCase()}|${(comic.variant ?? "").trim().toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(comic);
    groups.set(key, list);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

export function searchIndexFields(comic: { series: string; issueNo: string | null }): { seriesSort: string; issueSort: number | null } {
  return {
    seriesSort: comic.series.toLowerCase(),
    issueSort: issueNumberValue(comic.issueNo),
  };
}
