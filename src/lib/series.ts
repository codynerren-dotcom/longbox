import { issueNumberValue } from "@/lib/clz/parse";

export type SeriesIdentity = {
  series: string;
  publisher: string | null;
  coreSeriesId: string | null;
};

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function seriesRouteId(identity: SeriesIdentity): string {
  const core = identity.coreSeriesId?.trim();
  if (core) return core;
  return slugify(`${identity.series}-${identity.publisher ?? "unknown"}`) || "untitled";
}

export type RunComic = {
  id: string;
  issueNo: string | null;
  issueSort: number | null;
};

export type RunSlot = {
  issueNo: string;
  numeric: boolean;
  ownedIds: string[];
  wishlisted: boolean;
};

export function buildRun(comics: RunComic[], wishlistIssueNos: string[], cap = 150) {
  const numeric = comics
    .map((comic) => ({ comic, value: issueNumberValue(comic.issueNo) }))
    .filter((entry): entry is { comic: RunComic; value: number } => entry.value != null);

  const extras = comics.filter((comic) => issueNumberValue(comic.issueNo) == null && comic.issueNo);
  const wish = new Set(wishlistIssueNos);

  if (numeric.length === 0) {
    return {
      slots: extras.map((comic) => ({
        issueNo: comic.issueNo ?? "",
        numeric: false,
        ownedIds: [comic.id],
        wishlisted: wish.has(comic.issueNo ?? ""),
      })),
      missing: [] as string[],
      collapsed: false,
    };
  }

  const values = numeric.map((entry) => entry.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min + 1;
  const missing: string[] = [];

  if (span > cap) {
    const slots: RunSlot[] = numeric
      .slice()
      .sort((a, b) => a.value - b.value)
      .map((entry) => ({
        issueNo: String(entry.value),
        numeric: true,
        ownedIds: [entry.comic.id],
        wishlisted: false,
      }));
    for (let issue = min; issue <= max; issue += 1) {
      if (!values.includes(issue)) missing.push(String(issue));
    }
    return { slots, missing, collapsed: true };
  }

  const slots: RunSlot[] = [];
  for (let issue = min; issue <= max; issue += 1) {
    const issueNo = String(issue);
    const ownedIds = numeric.filter((entry) => entry.value === issue).map((entry) => entry.comic.id);
    if (ownedIds.length === 0) missing.push(issueNo);
    slots.push({ issueNo, numeric: true, ownedIds, wishlisted: wish.has(issueNo) });
  }
  for (const extra of extras) {
    slots.push({
      issueNo: extra.issueNo ?? "",
      numeric: false,
      ownedIds: [extra.id],
      wishlisted: wish.has(extra.issueNo ?? ""),
    });
  }
  return { slots, missing, collapsed: false };
}

export function ageBucket(year: number | null | undefined): string {
  if (year == null) return "Unknown";
  if (year < 1956) return "Golden";
  if (year < 1970) return "Silver";
  if (year < 1985) return "Bronze";
  if (year < 1992) return "Copper";
  return "Modern";
}

export const AGE_ORDER = ["Golden", "Silver", "Bronze", "Copper", "Modern", "Unknown"] as const;
