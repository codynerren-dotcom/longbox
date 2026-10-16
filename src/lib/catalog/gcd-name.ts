import type { GcdSeriesRow } from "@/lib/catalog/gcd";

/**
 * A name-search 404 is an empty result. The match panel shows this sentence.
 * The request URL is logged beside it.
 */
export class GcdNameMiss extends Error {
  readonly seriesName: string;

  constructor(seriesName: string) {
    super(`No GCD series named ${seriesName}`);
    this.name = "GcdNameMiss";
    this.seriesName = seriesName;
  }
}

/** GCD pages 50 series (`PAGE_SIZE` in gcd-django settings). Five pages cover a 219-row name search such as Spawn. */
export const GCD_NAME_PAGE_CAP = 5;

/**
 * Famous shelves. A crossover searches the other half so the one-shot is not
 * buried under thousands of Batman (or Superman, Spider-Man, …) series.
 */
const COMMON_FRANCHISE = new Set([
  "batman",
  "superman",
  "spider man",
  "spiderman",
  "x men",
  "avengers",
  "wonder woman",
  "justice league",
  "teen titans",
  "green lantern",
  "the flash",
  "flash",
  "fantastic four",
  "iron man",
  "captain america",
  "hulk",
  "wolverine",
  "deadpool",
  "star wars",
  "tmnt",
  "teenage mutant ninja turtles",
]);

const US_COUNTRY = /^(?:us|usa|u\.s\.a?\.?|united states(?: of america)?)$/i;
const EN_LANGUAGE = /^(?:en|eng|english)$/i;

/**
 * Comparison key. ` / `, `/`, ` - `, and `&` are the same separator, so
 * `Batman / Spawn`, `Batman/Spawn`, `Batman - Spawn`, and `Batman & Spawn` match.
 */
export function gcdSeriesNameKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s*(?:\/|&)\s*/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/['`.:]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One path segment. Slashes and other path-breaking characters never survive. */
export function gcdSeriesNameSegment(name: string): string | null {
  const cleaned = name
    .replace(/%2f/gi, " ")
    .replace(/[\\/#?%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return null;
  const encoded = encodeURIComponent(cleaned);
  if (encoded.includes("/") || /%2f/i.test(encoded)) return null;
  return encoded;
}

/**
 * Names to send to `/api/series/name/`. A slash is never one of them.
 * The longest rare part goes first (`Spawn` in `Batman / Spawn`), then the
 * same title with the slash removed (`Batman Spawn`).
 */
export function gcdSeriesNameQueries(name: string): string[] {
  const raw = name.replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const parts = raw
    .split("/")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 2);
  const queries: string[] = [];
  const add = (value: string) => {
    const trimmed = value
      .replace(/%2f/gi, " ")
      .replace(/[\\/#?%]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (trimmed.length < 2) return;
    if (/[\\/#?%]/.test(trimmed)) return;
    if (queries.some((query) => query.toLowerCase() === trimmed.toLowerCase())) return;
    queries.push(trimmed);
  };
  if (parts.length > 1) {
    const distinctive = parts.slice().sort((a, b) => partScore(b) - partScore(a) || b.length - a.length)[0];
    if (distinctive) add(distinctive);
    add(parts.join(" "));
    return queries;
  }
  add(raw);
  return queries;
}

function franchiseKey(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A one-franchise query such as `Batman`. A crossover should search the other half instead. */
export function gcdBareFranchise(name: string): boolean {
  return COMMON_FRANCHISE.has(franchiseKey(name));
}

function partScore(part: string): number {
  const key = franchiseKey(part);
  const letters = key.replace(/ /g, "").length;
  if (COMMON_FRANCHISE.has(key)) return letters - 1000;
  return letters;
}

/** The shelf copy is a US book: country, English with a blank country, or a US comic UPC. */
export function shelfIsUsBook(input: { country?: string | null; language?: string | null; barcode?: string | null }): boolean {
  const place = (input.country ?? "").trim();
  const tongue = (input.language ?? "").trim();
  if (place) return US_COUNTRY.test(place);
  if (EN_LANGUAGE.test(tongue)) return true;
  const digits = (input.barcode ?? "").replace(/\D/g, "");
  if (digits.length >= 12 && !digits.startsWith("978") && !digits.startsWith("979")) return true;
  return false;
}

export function isUsEnglishSeries(country: string | null | undefined, language: string | null | undefined): boolean {
  const place = (country ?? "").trim();
  const tongue = (language ?? "").trim();
  if (!US_COUNTRY.test(place) && place.toLowerCase() !== "us") return false;
  if (!tongue) return true;
  return EN_LANGUAGE.test(tongue);
}

function publisherAgrees(wanted: string, found: string): boolean {
  const left = wanted.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const right = found.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `);
}

function yearFits(row: GcdSeriesRow, year: number): boolean {
  if (row.yearBegan == null && row.yearEnded == null) return false;
  const began = row.yearBegan ?? row.yearEnded ?? year;
  const ended = row.yearEnded ?? row.yearBegan ?? year;
  return year >= Math.min(began, ended) && year <= Math.max(began, ended);
}

export type GcdSeriesRankHint = {
  name: string;
  publisher?: string | null;
  year?: number | null;
  usBook?: boolean;
};

/**
 * Keep series whose normalized name equals the shelf title, then prefer the
 * publisher, the year, and a US/English edition when the shelf copy is a US book.
 * A foreign edition stays in the list below that edition.
 */
export function rankGcdSeries(rows: GcdSeriesRow[], hint: GcdSeriesRankHint): GcdSeriesRow[] {
  const key = gcdSeriesNameKey(hint.name);
  if (!key) return [];
  const named = rows.filter((row) => gcdSeriesNameKey(row.name) === key);
  return named
    .map((row, index) => ({ row, index, score: rankScore(row, hint) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.row);
}

function rankScore(row: GcdSeriesRow, hint: GcdSeriesRankHint): number {
  let score = 0;
  if (hint.publisher && row.publisher && publisherAgrees(hint.publisher, row.publisher)) score += 100;
  if (hint.year != null && yearFits(row, hint.year)) score += 40;
  if (hint.year != null && row.yearBegan === hint.year) score += 10;
  if (hint.usBook && isUsEnglishSeries(row.country, row.language)) score += 20;
  return score;
}
