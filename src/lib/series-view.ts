import { costBasis, issueNumberValue } from "@/lib/clz/parse";

export type SeriesCopy = {
  id: string;
  series: string;
  publisher: string | null;
  issueNo: string | null;
  variant: string | null;
  variantDescription: string | null;
  releaseDate: Date | null;
  coverDate: string | null;
  coverYear: number | null;
  releaseYear: number | null;
  seriesYear: number | null;
  coverUrl: string | null;
  keyLevel: string | null;
  rawOrSlabbed: string | null;
  read: boolean;
  quantity: number;
  purchasePrice: { toString(): string } | string | null;
};

export type OwnedSeriesRow = {
  kind: "owned";
  comic: SeriesCopy;
  badge: string;
  letter: string;
  description: string | null;
  key: boolean;
};

export type SeriesRow = OwnedSeriesRow;

const SINGLE_LETTER = /^[A-Za-z]$/;
const LABELED_LETTER = /^(?:cover|variant|var\.?)\s+([A-Za-z])$/i;

/** A variant letter is a single A–Z, or a "Cover B" / "Variant B" label. Long descriptions have none. */
export function variantLetter(variant: string | null | undefined, description?: string | null): string {
  return letterFrom(variant) || letterFrom(description);
}

function letterFrom(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  if (!text) return "";
  if (SINGLE_LETTER.test(text)) return text.toUpperCase();
  const labeled = LABELED_LETTER.exec(text);
  return labeled ? labeled[1].toUpperCase() : "";
}

/** `#1` plus the variant letter: `#1A`. A letter already on the issue number is not repeated. */
export function issueBadge(issueNo: string | null | undefined, letter: string): string {
  const issue = (issueNo ?? "").trim();
  const mark = letter.trim().toUpperCase();
  if (!issue) return mark ? `#${mark}` : "#";
  if (!mark || issue.toUpperCase().endsWith(mark)) return `#${issue}`;
  return `#${issue}${mark}`;
}

export function variantDescriptionText(comic: Pick<SeriesCopy, "variant" | "variantDescription">): string | null {
  const description = comic.variantDescription?.trim();
  if (description) return description;
  const variant = comic.variant?.trim() ?? "";
  if (!variant || SINGLE_LETTER.test(variant) || LABELED_LETTER.test(variant)) return null;
  return variant;
}

export function isKeyIssue(keyLevel: string | null | undefined): boolean {
  const text = keyLevel?.trim() ?? "";
  if (!text || /^no$/i.test(text)) return false;
  return true;
}

function copyQuantity(comic: SeriesCopy): number {
  return Number.isInteger(comic.quantity) && comic.quantity > 0 ? comic.quantity : 1;
}

export function copyCountLabel(comics: SeriesCopy[]): string {
  const copies = comics.reduce((sum, comic) => sum + copyQuantity(comic), 0);
  return copies === 1 ? "1 comic" : `${copies} comics`;
}

/** Owned numeric span, `Have: 1-12`, or `Have: 5` when only one number is on the shelf. */
export function haveRange(comics: SeriesCopy[]): string | null {
  const numbers = comics
    .map((comic) => issueNumberValue(comic.issueNo))
    .filter((value): value is number => value != null);
  if (numbers.length === 0) return null;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? `Have: ${min}` : `Have: ${min}-${max}`;
}

export function ownedIssueCount(comics: SeriesCopy[]): number {
  const seen = new Set<string>();
  for (const comic of comics) {
    const value = issueNumberValue(comic.issueNo);
    seen.add(value != null ? `#${value}` : (comic.issueNo?.trim() || comic.id));
  }
  return seen.size;
}

function plausibleYear(year: number | null | undefined): number | null {
  if (year == null || !Number.isInteger(year)) return null;
  if (year < 1890 || year > 2100) return null;
  return year;
}

function yearOf(comic: SeriesCopy): number | null {
  return plausibleYear(comic.coverYear) ?? plausibleYear(comic.releaseYear) ?? plausibleYear(comic.seriesYear);
}

/** Cover year, then release year, then series year. An en dash joins a span. */
export function yearSpan(comics: SeriesCopy[]): string | null {
  const years = comics.map(yearOf).filter((year): year is number => year != null);
  if (years.length === 0) return null;
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? String(min) : `${min}\u2013${max}`;
}

/** Sum of per-copy cost basis, as a 2-decimal string. Null when nothing has a price. */
export function seriesSpend(comics: SeriesCopy[]): string | null {
  let cents = 0;
  let any = false;
  for (const comic of comics) {
    const line = costBasis(comic.purchasePrice, comic.quantity);
    if (!line) continue;
    any = true;
    const negative = line.startsWith("-");
    const digits = Number((negative ? line.slice(1) : line).replace(".", ""));
    cents += negative ? -digits : digits;
  }
  if (!any) return null;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function majorityPublisher(comics: Array<{ publisher?: string | null }>): string {
  const counts = new Map<string, number>();
  for (const comic of comics) {
    const name = comic.publisher?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function compareCopies(a: SeriesCopy, b: SeriesCopy): number {
  const an = issueNumberValue(a.issueNo);
  const bn = issueNumberValue(b.issueNo);
  if (an != null && bn != null && an !== bn) return an - bn;
  if (an != null && bn == null) return -1;
  if (an == null && bn != null) return 1;
  if (an == null && bn == null) {
    const issue = (a.issueNo ?? "").localeCompare(b.issueNo ?? "", undefined, { numeric: true });
    if (issue !== 0) return issue;
  }
  const al = variantLetter(a.variant, a.variantDescription);
  const bl = variantLetter(b.variant, b.variantDescription);
  if (al !== bl) {
    if (!al) return -1;
    if (!bl) return 1;
    return al.localeCompare(bl);
  }
  const description = (a.variantDescription ?? "").localeCompare(b.variantDescription ?? "");
  if (description !== 0) return description;
  return a.id.localeCompare(b.id);
}

function ownedRow(comic: SeriesCopy): OwnedSeriesRow {
  const letter = variantLetter(comic.variant, comic.variantDescription);
  return {
    kind: "owned",
    comic,
    badge: issueBadge(comic.issueNo, letter),
    letter,
    description: variantDescriptionText(comic),
    key: isKeyIssue(comic.keyLevel),
  };
}

/** One owned copy per row, sorted by issue number then variant letter. Gaps are not included. */
export function buildSeriesRows(comics: SeriesCopy[]): SeriesRow[] {
  return comics.slice().sort(compareCopies).map(ownedRow);
}
