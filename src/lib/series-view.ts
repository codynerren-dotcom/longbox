import { costBasis, issueNumberValue } from "@/lib/clz/parse";
import { formatMoney } from "@/lib/format";

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
  keyReason: string | null;
  title: string | null;
  storyArc: string | null;
  writer: string | null;
  coverArtist: string | null;
  grade: string | null;
  gradingCompany: string | null;
  rawOrSlabbed: string | null;
  storageBox: string | null;
  signedBy: string | null;
  read: boolean;
  quantity: number;
  purchasePrice: { toString(): string } | string | null;
  value: { toString(): string } | string | null;
  myValue: { toString(): string } | string | null;
  /** Latest priced quote, when a pricing run has stored one. */
  priceQuote: { amount: { toString(): string } | string | null; currency: string | null } | null;
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

export type RowCondition = { text: string; slab: boolean };

/** Fields worth showing on a series row. Empty values stay null so the row can skip them. */
export type RowFacts = {
  story: string | null;
  keyReason: string | null;
  creators: string | null;
  condition: RowCondition | null;
  copies: string | null;
  box: string | null;
  paid: string | null;
  value: string | null;
  signed: string | null;
};

function filled(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text ? text : null;
}

function sameAsSeries(title: string, series: string): boolean {
  const value = title.trim().toLowerCase();
  const name = series.trim().toLowerCase();
  if (!name) return false;
  return value === name || value.startsWith(`${name} #`) || value.startsWith(`${name}#`);
}

/** A real story title, otherwise the arc. A title that just repeats the series name is skipped. */
export function storyLine(series: string, title: string | null | undefined, arc: string | null | undefined): string | null {
  const storyTitle = filled(title);
  const arcTitle = filled(arc);
  const useful = storyTitle && !sameAsSeries(storyTitle, series) ? storyTitle : null;
  if (useful && arcTitle && arcTitle.toLowerCase() !== useful.toLowerCase()) return `${useful} · ${arcTitle}`;
  return useful ?? arcTitle;
}

/** Writer, then cover artist. One name is not repeated when both credits match. */
export function creatorsLine(writer: string | null | undefined, coverArtist: string | null | undefined): string | null {
  const written = filled(writer);
  const cover = filled(coverArtist);
  if (written && cover && written.toLowerCase() !== cover.toLowerCase()) return `Writer ${written} · Cover ${cover}`;
  if (written) return `Writer ${written}`;
  if (cover) return `Cover ${cover}`;
  return null;
}

function conditionOf(comic: SeriesCopy): RowCondition | null {
  const grade = filled(comic.grade);
  const raw = filled(comic.rawOrSlabbed);
  const company = filled(comic.gradingCompany);
  const slab = raw != null && /^slab/i.test(raw);
  if (slab) {
    const head = company ?? "Slab";
    return { text: grade ? `${head} ${grade}` : head, slab: true };
  }
  if (!grade && !raw) return null;
  if (grade && raw) return { text: `${raw} ${grade}`, slab: false };
  return { text: grade ?? raw ?? "", slab: false };
}

function moneyText(amount: { toString(): string } | string | null | undefined, currency: string): string | null {
  if (amount == null || amount === "") return null;
  const formatted = formatMoney(amount, currency);
  return formatted === "—" ? null : formatted;
}

function signedLabel(signedBy: string | null | undefined): string | null {
  const name = filled(signedBy);
  if (!name) return null;
  if (/^(yes|y|signed)$/i.test(name)) return "Signed";
  return `Signed ${name}`;
}

export function seriesRowFacts(comic: SeriesCopy, currency = "USD"): RowFacts {
  const quoteCurrency = filled(comic.priceQuote?.currency) ?? currency;
  const quoted = comic.priceQuote ? moneyText(comic.priceQuote.amount, quoteCurrency) : null;
  const storedValue = moneyText(comic.value, currency) ?? moneyText(comic.myValue, currency);
  const current = quoted ?? storedValue;
  const paid = moneyText(comic.purchasePrice, currency);
  const copies = copyQuantity(comic);
  return {
    story: storyLine(comic.series, comic.title, comic.storyArc),
    keyReason: isKeyIssue(comic.keyLevel) ? filled(comic.keyReason) : null,
    creators: creatorsLine(comic.writer, comic.coverArtist),
    condition: conditionOf(comic),
    copies: copies > 1 ? `${copies} copies` : null,
    box: filled(comic.storageBox),
    paid: paid ? `Paid ${paid}` : null,
    value: current ? `Value ${current}` : null,
    signed: signedLabel(comic.signedBy),
  };
}
