import { costBasis, issueNumberValue } from "@/lib/clz/parse";
import { formatMoney } from "@/lib/format";
import { isCollected, shelfFormatOf, volumeLabel, volumeNumber } from "@/lib/shelf-format";

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
  shelfFormat?: string | null;
};

export type OwnedSeriesRow = {
  kind: "owned";
  /** Display copy. The shelf records stay in `copies`. */
  comic: SeriesCopy;
  copies: SeriesCopy[];
  badge: string;
  letter: string;
  description: string | null;
  key: boolean;
  /** Sum of each record's quantity. */
  quantity: number;
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

/** `#1` plus the variant letter: `#1A`. Collected editions read `Vol. 1`. */
export function issueBadge(issueNo: string | null | undefined, letter: string, format?: string | null): string {
  if (format && isCollected(shelfFormatOf(format))) return volumeLabel(issueNo);
  const issue = (issueNo ?? "").trim();
  const mark = letter.trim().toUpperCase();
  if (!issue) return mark ? `#${mark}` : "#";
  if (!mark || issue.toUpperCase().endsWith(mark)) return `#${issue}`;
  return `#${issue}${mark}`;
}

export function variantDescriptionText(comic: { variant: string | null; variantDescription?: string | null }): string | null {
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

export function copyQuantity(comic: { quantity: number }): number {
  return Number.isInteger(comic.quantity) && comic.quantity > 0 ? comic.quantity : 1;
}

export type CopyIdentity = {
  series: string;
  issueNo: string | null;
  variant: string | null;
  variantDescription?: string | null;
  quantity: number;
};

/** Series, issue number, variant letter, and variant description. `1A` and issue 1 + variant A match. */
export function copyGroupKey(comic: CopyIdentity): string {
  const series = comic.series.trim().toLowerCase();
  const { issue, letter } = issueAndLetter(comic);
  const description = (variantDescriptionText(comic) ?? "").trim().toLowerCase();
  return `${series}|${issue}|${letter}|${description}`;
}

function issueAndLetter(comic: Pick<CopyIdentity, "issueNo" | "variant" | "variantDescription">): { issue: string; letter: string } {
  const fromFields = variantLetter(comic.variant, comic.variantDescription);
  const raw = (comic.issueNo ?? "").trim();
  const volume = volumeNumber(raw);
  if (volume && /vol|volume|^v\.?\s*\d/i.test(raw)) return { issue: volume, letter: fromFields };
  const numeric = issueNumberValue(raw);
  if (numeric != null) return { issue: String(numeric), letter: fromFields };
  const trailing = raw.match(/^(\d+)([A-Za-z])$/);
  if (trailing) {
    const onIssue = trailing[2].toUpperCase();
    if (!fromFields || fromFields === onIssue) return { issue: String(Number(trailing[1])), letter: onIssue };
  }
  return { issue: raw.toLowerCase(), letter: fromFields };
}

/** Keep records in order and collapse rows that are the same series, issue, and variant. */
export function groupCopies<T extends CopyIdentity>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = copyGroupKey(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

export function groupQuantity(items: Array<{ quantity: number }>): number {
  return items.reduce((sum, item) => sum + copyQuantity(item), 0);
}

/** Distinct base issues, then copies when a number has more than one. `3G` and `3H` are one comic. */
export function copyCountLabel(comics: CopyIdentity[]): string {
  const issues = distinctBaseIssues(comics);
  const copies = groupQuantity(comics);
  const comicLabel = issues === 1 ? "1 comic" : `${issues} comics`;
  if (copies === issues) return comicLabel;
  const copyLabel = copies === 1 ? "1 copy" : `${copies} copies`;
  return `${comicLabel} · ${copyLabel}`;
}

function distinctBaseIssues(comics: CopyIdentity[]): number {
  const seen = new Set<string>();
  let unlabeled = 0;
  for (const comic of comics) {
    const series = comic.series.trim().toLowerCase();
    const label = baseIssueLabel(comic.issueNo ?? "");
    if (!label) {
      unlabeled += 1;
      continue;
    }
    seen.add(`${series}|${issueKey(label)}`);
  }
  return seen.size + unlabeled;
}

/** Owned base numbers, grouped only when they are consecutive. `#7E` and `#55A` are `Have: #7, #55`, not `Have: #7-#55`. */
export function haveRange(comics: SeriesCopy[]): string | null {
  const numbers = ownedIssueNumbers(comics);
  if (numbers.length === 0) return null;
  return `Have: ${collapseNumbers(numbers, "have").parts.join(", ")}`;
}

/**
 * A catalog run. `issueCount` is the length of the run (`1..N`) once variant
 * rows have been folded out. `numbers` adds labels such as annuals. With neither,
 * Missing is only the holes between the first and last owned issue.
 */
export type CatalogRun = {
  numbers: string[];
  issueCount: number | null;
};

export type MissingChip = {
  kind: "missing";
  count: number;
  parts: string[];
};

const MAX_SERIES_COUNT = 20_000;

/** Positive issue count small enough to compare against a shelf. */
export function catalogIssueCount(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number.parseInt(value.trim(), 10)
        : null;
  if (parsed == null || !Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_SERIES_COUNT) return null;
  return parsed;
}

const BRACKETED = /\[[^\]]*\]/g;
const PAREN_VARIANT = /\s*\([^)]*\b(?:cover|variant|var\.?|printing|print|facsimile|reprint)[^)]*\)/gi;
const LETTER_SUFFIX = /^(\d+)([A-Za-z])$/;
const VARIANT_WORDS = /\b(?:alternate\s+covers?|alt(?:ernate)?\s+covers?|covers?|variants?|var\.?|printings?|prints?|facsimiles?|reprints?|incentive|virgin|foil|sketch)\b/i;

/**
 * A cover, later printing, facsimile, or lettered suffix such as `1K`.
 * Annuals are their own issues.
 */
export function isVariantDescriptor(raw: string): boolean {
  const label = raw.trim();
  if (!label) return false;
  if (/\[[^\]]+\]/.test(label)) return true;
  if (LETTER_SUFFIX.test(label)) return true;
  if (VARIANT_WORDS.test(label) && !/\bannuals?\b/i.test(label)) return true;
  return false;
}

/**
 * One label per base issue. `01`, `1 [Cover A]`, and `1K` are all `1`.
 * Alternate covers, later printings, facsimiles, and other variant notes drop out.
 * Annuals and halves such as `1.5` stay as written.
 */
export function distinctIssueLabels(raw: string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of raw) {
    const label = baseIssueLabel(item);
    if (!label) continue;
    const key = issueKey(label);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

/**
 * Reported `issue_count` values count every cover. When variant rows explain
 * that gap, the run length is the distinct base numbers.
 */
export function catalogBaseCount(raw: string[], reported: number | null): number | null {
  const numbers = distinctIssueLabels(raw);
  if (numbers.length === 0 || reported == null || reported <= numbers.length) return reported;
  const variantRows = raw.filter((item) => isVariantDescriptor(item)).length;
  if (variantRows > 0 && reported - numbers.length <= variantRows) return numbers.length;
  return reported;
}

/** Base issue. `1 [Cover A - Ryan Browne]`, `2 [Second Printing]`, and `1K` are `1` / `2` / `1`. */
export function baseIssueLabel(raw: string): string | null {
  const label = raw.trim();
  if (!label) return null;
  const stripped = label.replace(BRACKETED, " ").replace(PAREN_VARIANT, " ").replace(/\s+/g, " ").trim();
  const number = numericBase(stripped) ?? variantLeadingNumber(stripped);
  if (number != null) return String(number);
  if (!stripped || variantNote(label) || variantNote(stripped)) return null;
  return stripped;
}

function numericBase(label: string): number | null {
  if (/^\d+$/.test(label)) {
    const parsed = Number.parseInt(label, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const lettered = LETTER_SUFFIX.exec(label);
  if (!lettered) return null;
  const parsed = Number.parseInt(lettered[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** `1 Cover A` is issue 1. `1.5` and `Annual 1` are not. */
function variantLeadingNumber(label: string): number | null {
  const match = /^#?\s*(\d+)[A-Za-z]?\b(.*)$/.exec(label);
  if (!match) return null;
  const rest = (match[2] ?? "").trim();
  if (!rest || rest.startsWith(".")) return null;
  if (!variantNote(rest)) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function variantNote(label: string): boolean {
  const text = label.trim();
  if (!text) return false;
  if (/\[[^\]]+\]/.test(text) && !/\d/.test(text.replace(/\[[^\]]*\]/g, ""))) return true;
  return VARIANT_WORDS.test(text);
}

function canonicalIssueLabel(raw: string): string | null {
  return baseIssueLabel(raw);
}

function issueKey(label: string): string {
  const value = issueNumberValue(label);
  return value != null && value > 0 ? `n:${value}` : `s:${label.toLowerCase()}`;
}

/** True when Metron, GCD, or Comic Vine supplied an issue count or an issue list. */
export function seriesCatalogKnown(run: CatalogRun | null): boolean {
  if (!run) return false;
  if (catalogIssueCount(run.issueCount) != null) return true;
  return run.numbers.length > 0;
}

/**
 * Missing issues for the header. A known issue count is `1..N`, so it includes
 * numbers before the first owned issue and after the last. With no catalog,
 * only the holes between the first and last owned number are listed.
 * Variants of one number count as owned. Null when nothing is missing.
 */
export function seriesMissing(comics: SeriesCopy[], run: CatalogRun | null): MissingChip | null {
  const numeric = new Set<number>();
  const text: string[] = [];
  const owned = ownedKeys(comics);
  const ownedNumbers = ownedIssueNumbers(comics);
  if (seriesCatalogKnown(run) && run) {
    const ceiling = catalogBaseCount(run.numbers, catalogIssueCount(run.issueCount));
    if (ceiling != null) {
      const present = new Set(ownedNumbers);
      for (let issue = 1; issue <= ceiling; issue += 1) {
        if (!present.has(issue)) numeric.add(issue);
      }
    }
    for (const label of distinctIssueLabels(run.numbers)) {
      const value = issueNumberValue(label);
      if (value != null && value > 0) {
        if (!owned.has(`n:${value}`)) numeric.add(value);
      } else if (!owned.has(issueKey(label))) {
        text.push(label);
      }
    }
  } else {
    for (let index = 0; index < ownedNumbers.length - 1; index += 1) {
      for (let hole = ownedNumbers[index] + 1; hole < ownedNumbers[index + 1]; hole += 1) numeric.add(hole);
    }
  }
  const collapsed = collapseNumbers([...numeric], "missing");
  const count = collapsed.count + text.length;
  if (count === 0) return null;
  return { kind: "missing", count, parts: [...collapsed.parts, ...text] };
}

export function seriesHeaderSummary(comics: SeriesCopy[], run: CatalogRun | null): string {
  const parts = [copyCountLabel(comics)];
  const have = haveRange(comics);
  if (have) parts.push(have);
  const missing = seriesMissing(comics, run);
  if (missing) parts.push(missingClause(missing));
  if (!seriesCatalogKnown(run)) parts.push("(catalog unknown)");
  return parts.join(" · ");
}

export function missingClause(missing: MissingChip, parts = missing.parts): string {
  return `Missing ${missing.count}: ${parts.join(", ")}`;
}

/** Keep the first collapsed parts that fit, so a long list can offer "show all". */
export function truncateMissingParts(parts: string[], maxChars = 56): { shown: string[]; rest: number } {
  if (parts.length === 0) return { shown: [], rest: 0 };
  if (parts.join(", ").length <= maxChars) return { shown: parts, rest: 0 };
  const shown: string[] = [];
  let length = 0;
  for (const part of parts) {
    const next = shown.length === 0 ? part.length : length + 2 + part.length;
    if (shown.length > 0 && next > maxChars) break;
    shown.push(part);
    length = next;
  }
  return { shown, rest: parts.length - shown.length };
}

/** Have marks both ends (`#1-#3`). Missing marks the start (`#1-14`), matching Alpha Flight. */
function collapseNumbers(values: number[], style: "have" | "missing"): { count: number; parts: string[] } {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  let count = 0;
  let start: number | null = null;
  let prev: number | null = null;
  const part = (from: number, to: number) => {
    if (from === to) return `#${from}`;
    return style === "have" ? `#${from}-#${to}` : `#${from}-${to}`;
  };
  for (const value of sorted) {
    if (start == null || prev == null) {
      start = value;
      prev = value;
      continue;
    }
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    parts.push(part(start, prev));
    count += prev - start + 1;
    start = value;
    prev = value;
  }
  if (start != null && prev != null) {
    parts.push(part(start, prev));
    count += prev - start + 1;
  }
  return { count, parts };
}

function ownedKeys(comics: SeriesCopy[]): Set<string> {
  const owned = new Set<string>();
  for (const comic of comics) {
    const label = canonicalIssueLabel(comic.issueNo ?? "");
    if (label) owned.add(issueKey(label));
  }
  return owned;
}

function ownedIssueNumbers(comics: SeriesCopy[]): number[] {
  const owned = new Set<number>();
  for (const comic of comics) {
    const label = baseIssueLabel(comic.issueNo ?? "");
    if (!label || !/^\d+$/.test(label)) continue;
    owned.add(Number.parseInt(label, 10));
  }
  return [...owned].sort((a, b) => a - b);
}

export function ownedIssueCount(comics: SeriesCopy[]): number {
  const seen = new Set<string>();
  for (const comic of comics) {
    const label = baseIssueLabel(comic.issueNo ?? "");
    seen.add(label ?? (comic.issueNo?.trim() || comic.id));
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

function strongestKey(copies: SeriesCopy[]): string | null {
  if (copies.some((copy) => /^major$/i.test(copy.keyLevel ?? ""))) return "Major";
  if (copies.some((copy) => /^minor$/i.test(copy.keyLevel ?? ""))) return "Minor";
  const other = copies.find((copy) => isKeyIssue(copy.keyLevel));
  return other?.keyLevel ?? copies[0]?.keyLevel ?? null;
}

function groupedRow(copies: SeriesCopy[]): OwnedSeriesRow {
  const lead = copies.find((copy) => copy.coverUrl) ?? copies[0];
  const { letter } = issueAndLetter(lead);
  const keyLevel = strongestKey(copies);
  return {
    kind: "owned",
    comic: { ...lead, keyLevel, read: copies.every((copy) => copy.read) },
    copies,
    badge: issueBadge(lead.issueNo, letter, lead.shelfFormat),
    letter,
    description: variantDescriptionText(lead),
    key: isKeyIssue(keyLevel),
    quantity: groupQuantity(copies),
  };
}

/** One row per series, issue, and variant. Duplicate records stay in `copies`. */
export function buildSeriesRows(comics: SeriesCopy[]): SeriesRow[] {
  return groupCopies(comics.slice().sort(compareCopies)).map(groupedRow);
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
  /** Total purchase price times quantity. Shown when the row is more than one copy. */
  basis: string | null;
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

function signedLabel(signedBy: string | null | undefined): string | null {
  const name = filled(signedBy);
  if (!name) return null;
  if (/^(yes|y|signed)$/i.test(name)) return "Signed";
  return `Signed ${name}`;
}

export function seriesRowFacts(comic: SeriesCopy, currency = "USD"): RowFacts {
  return groupRowFacts([comic], currency);
}

/** Paid is the per-copy price when every copy matches, otherwise a range. Cost is the total. */
export function groupRowFacts(copies: SeriesCopy[], currency = "USD"): RowFacts {
  const lead = copies[0];
  const story = copies.map((copy) => storyLine(copy.series, copy.title, copy.storyArc)).find((line) => line) ?? null;
  const keyReason = copies.map((copy) => (isKeyIssue(copy.keyLevel) ? filled(copy.keyReason) : null)).find((line) => line) ?? null;
  const creators = copies.map((copy) => creatorsLine(copy.writer, copy.coverArtist)).find((line) => line) ?? null;
  const signed = sharedSigned(copies);
  const money = aggregateMoney(copies, currency);
  return {
    story,
    keyReason,
    creators,
    condition: aggregateCondition(copies),
    copies: null,
    box: aggregateBoxes(copies),
    paid: money.paid,
    basis: lead && groupQuantity(copies) > 1 ? money.basis : null,
    value: money.value,
    signed,
  };
}

function aggregateCondition(copies: SeriesCopy[]): RowCondition | null {
  const conditions = copies.map(conditionOf);
  const present = conditions.filter((condition): condition is RowCondition => condition != null);
  if (present.length === 0) return null;
  const first = present[0];
  const same = present.length === copies.length && present.every((condition) => condition.text === first.text && condition.slab === first.slab);
  if (same) return first;
  return { text: "mixed", slab: false };
}

function aggregateBoxes(copies: SeriesCopy[]): string | null {
  const boxes: string[] = [];
  for (const copy of copies) {
    const box = filled(copy.storageBox);
    if (!box || boxes.some((name) => name.toLowerCase() === box.toLowerCase())) continue;
    boxes.push(box);
  }
  return boxes.length > 0 ? boxes.join(", ") : null;
}

function sharedSigned(copies: SeriesCopy[]): string | null {
  const labels = copies.map((copy) => signedLabel(copy.signedBy));
  const present = labels.filter((label): label is string => label != null);
  if (present.length === 0) return null;
  if (present.length === copies.length && present.every((label) => label === present[0])) return present[0];
  return null;
}

function unitCents(price: { toString(): string } | string | null | undefined): number | null {
  const line = costBasis(price, 1);
  if (!line) return null;
  const negative = line.startsWith("-");
  const digits = Number((negative ? line.slice(1) : line).replace(".", ""));
  return negative ? -digits : digits;
}

function moneyFromCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return formatMoney(`${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`, currency);
}

function aggregateMoney(copies: SeriesCopy[], currency: string): { paid: string | null; basis: string | null; value: string | null } {
  const prices = copies.map((copy) => unitCents(copy.purchasePrice));
  const known = prices.filter((cents): cents is number => cents != null);
  let paid: string | null = null;
  if (known.length > 0 && known.length === copies.length) {
    const low = Math.min(...known);
    const high = Math.max(...known);
    paid = low === high ? `Paid ${moneyFromCents(low, currency)}` : `Paid ${moneyFromCents(low, currency)}-${moneyFromCents(high, currency)}`;
  } else if (known.length > 0) {
    paid = "Paid mixed";
  }
  let basisCents = 0;
  let anyBasis = false;
  for (const copy of copies) {
    const line = costBasis(copy.purchasePrice, copy.quantity);
    if (!line) continue;
    anyBasis = true;
    const negative = line.startsWith("-");
    const digits = Number((negative ? line.slice(1) : line).replace(".", ""));
    basisCents += negative ? -digits : digits;
  }
  const values = copies.map((copy) => valueCents(copy)).filter((cents): cents is number => cents != null);
  let value: string | null = null;
  if (values.length === copies.length && values.length > 0) {
    const low = Math.min(...values);
    const high = Math.max(...values);
    value = low === high ? `Value ${moneyFromCents(low, currency)}` : `Value ${moneyFromCents(low, currency)}-${moneyFromCents(high, currency)}`;
  }
  return {
    paid,
    basis: anyBasis ? `Cost ${moneyFromCents(basisCents, currency)}` : null,
    value,
  };
}

function valueCents(comic: SeriesCopy): number | null {
  if (comic.priceQuote) return unitCents(comic.priceQuote.amount);
  return unitCents(comic.value) ?? unitCents(comic.myValue);
}
