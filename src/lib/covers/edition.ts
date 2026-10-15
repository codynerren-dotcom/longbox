import { parseComicBarcode } from "@/lib/barcode";
import { seriesTitleFits } from "@/lib/shelf-format";

export const AUTO_LINK_SCORE = 75;
export const DECADE_YEARS = 10;
export const FACSIMILE_DATE_WINDOW_DAYS = 60;

const PRINTING_WORDS: Record<number, readonly [string, string]> = {
  1: ["1st", "first"],
  2: ["2nd", "second"],
  3: ["3rd", "third"],
  4: ["4th", "fourth"],
  5: ["5th", "fifth"],
  6: ["6th", "sixth"],
  7: ["7th", "seventh"],
  8: ["8th", "eighth"],
  9: ["9th", "ninth"],
  10: ["10th", "tenth"],
};

export type EditionKind = "regular" | "facsimile" | "reprint" | "printing" | "anniversary" | "true-believers" | "omnibus";

export type EditionCopy = {
  series: string;
  issueNo?: string | null;
  title?: string | null;
  fullTitle?: string | null;
  variant?: string | null;
  variantDescription?: string | null;
  format?: string | null;
  subtitle?: string | null;
  publisher?: string | null;
  barcode?: string | null;
  coverYear?: number | null;
  releaseYear?: number | null;
  releaseDate?: Date | string | null;
  seriesYear?: number | null;
  coverPrice?: unknown;
  catalogStoreYear?: number | null;
  /** Printing number whose cover was confirmed for this linked copy. */
  catalogPrinting?: number | null;
};

export type FacsimileSearch = {
  series: string;
  issueNo: string;
};

export type EditionProfile = {
  kind: EditionKind;
  reprint: boolean;
  baseSeries: string;
  searchNames: string[];
  /** Series and issue pairs for a facsimile. Empty for every other kind. */
  facsimileSearches: FacsimileSearch[];
  /** Issue number with trailing variant letters removed for a facsimile or later printing. */
  issueNo: string | null;
  /** 2 or higher for a later printing. First printing and everything else stay null. */
  printing: number | null;
  reasons: string[];
};

export type MatchCandidate = {
  seriesName: string;
  issueNo: string;
  variant: string | null;
  coverYear: number | null;
  releaseYear: number | null;
  seriesYear: number | null;
  upc: string | null;
  publisher: string | null;
  storeDate?: string | null;
};

export type MatchScore = {
  score: number;
  auto: boolean;
  blocked: string | null;
  kind: EditionKind;
  candidateKind: EditionKind;
};

const KIND_LABEL: Record<EditionKind, string> = {
  regular: "regular",
  facsimile: "facsimile",
  reprint: "reprint",
  printing: "later printing",
  anniversary: "anniversary edition",
  "true-believers": "True Believers",
  omnibus: "omnibus",
};

export function priceAmount(value: unknown): number | null {
  if (value == null) return null;
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : typeof value === "object" ? String(value) : "";
  const match = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

export function detectEdition(copy: EditionCopy): EditionProfile {
  const text = [copy.series, copy.title, copy.fullTitle, copy.variant, copy.variantDescription, copy.format, copy.subtitle]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" \n ");
  const reasons: string[] = [];
  let kind = kindFromText(text);
  if (kind !== "regular") reasons.push(`The copy says ${KIND_LABEL[kind]}.`);
  const release = yearOf(copy.releaseYear);
  const cover = yearOf(copy.coverYear);
  if (release != null && cover != null && release - cover >= DECADE_YEARS) {
    reasons.push(`Release year ${release} is ${release - cover} years after cover year ${cover}.`);
    if (kind === "regular") kind = "facsimile";
  }
  const price = priceAmount(copy.coverPrice);
  if (price != null && price >= 3 && cover != null && cover <= 1985 && (release == null || release - cover >= DECADE_YEARS)) {
    reasons.push(`Cover price ${price.toFixed(2)} does not match a ${cover} comic.`);
    if (kind === "regular") kind = "facsimile";
  }
  const started = yearOf(copy.seriesYear);
  if (kind === "regular" && release != null && started != null && release - started >= DECADE_YEARS && (cover == null || release - cover >= DECADE_YEARS)) {
    reasons.push(`Release year ${release} is ${release - started} years after the series started in ${started}.`);
    kind = "facsimile";
  }
  const described = printingNumberFromText(text);
  const fromBarcode = printingNumberFromBarcode(copy.barcode);
  let printing: number | null = null;
  if (described != null && described >= 2) printing = described;
  else if (described == null && fromBarcode != null && fromBarcode >= 2) printing = fromBarcode;
  if (described === 1) printing = null;
  if (printing != null && kind === "regular") {
    kind = "printing";
    reasons.push(`The copy is a ${printingOrdinal(printing)} printing.`);
  }
  if (kind === "printing" && printing != null) {
    if (described != null && fromBarcode != null && described === fromBarcode) {
      reasons.push(`The variant description and the UPC add-on both say ${printingOrdinal(printing)} printing.`);
    } else if (described != null) reasons.push(`The variant description says ${printingOrdinal(printing)} printing.`);
    else reasons.push(`The UPC add-on says ${printingOrdinal(printing)} printing.`);
  }
  const baseSeries = baseSeriesName(copy.series) || copy.series.trim();
  const stripped = stripIssueVariant(copy.issueNo);
  const facsimileSearches = kind === "facsimile" ? buildFacsimileSearches(copy.series, stripped.number) : [];
  const laterPrinting = kind === "printing" && printing != null;
  return {
    kind,
    reprint: kind !== "regular",
    baseSeries,
    searchNames: kind === "facsimile" ? facsimileSearches.map((search) => search.series) : searchNames(kind, copy.series, baseSeries),
    facsimileSearches,
    issueNo: kind === "facsimile" || laterPrinting ? stripped.number || null : copy.issueNo?.trim() || null,
    printing: laterPrinting ? printing : null,
    reasons,
  };
}

/** "300K" and "1AX" keep the issue number and drop the CLZ variant letters. */
export function stripIssueVariant(issueNo: string | null | undefined): { number: string; letter: string | null } {
  const trimmed = (issueNo ?? "").trim().replace(/^#\s*/, "");
  const match = trimmed.match(/^(\d+)([A-Za-z]+)$/);
  if (!match) return { number: trimmed, letter: null };
  return { number: match[1], letter: match[2].toUpperCase() };
}

/** Word or ordinal in front of "printing". "First" and "1st" are 1. */
export function printingNumberFromText(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.toLowerCase();
  const word = text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+printings?\b/);
  if (word) {
    const found = Object.entries(PRINTING_WORDS).find(([, names]) => names[1] === word[1]);
    return found ? Number(found[0]) : null;
  }
  const digit = text.match(/\b(\d+)(?:st|nd|rd|th)\s+printings?\b/);
  if (!digit) return null;
  const printing = Number(digit[1]);
  if (!Number.isInteger(printing) || printing < 1 || printing > 20) return null;
  return printing;
}

/**
 * US comic add-on is issue, cover, printing (IIICP). The last digit is the printing.
 * 1 is the first printing. 2 through 9 are later printings.
 */
export function printingNumberFromBarcode(barcode: string | null | undefined): number | null {
  if (!barcode) return null;
  const parsed = parseComicBarcode(barcode);
  if (!parsed?.addon || parsed.addon.length !== 5) return null;
  const printing = Number(parsed.addon.slice(-1));
  if (!Number.isInteger(printing) || printing < 1 || printing > 9) return null;
  return printing;
}

export function printingOrdinal(printing: number): string {
  return PRINTING_WORDS[printing]?.[0] ?? `${printing}th`;
}

export function printingWords(printing: number): string[] {
  const known = PRINTING_WORDS[printing];
  return known ? [known[0], known[1]] : [`${printing}th`];
}

export function labelMatchesPrinting(label: string, printing: number): boolean {
  if (!/\bprintings?\b/i.test(label)) return false;
  return printingWords(printing).some((word) => new RegExp(`\\b${word}\\b`, "i").test(label));
}

/** Cover-artist words left after the printing phrase, such as "Travel Foreman". */
export function printingArtistHint(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\s+printings?\b/gi, " ")
    .replace(/\b(?:printings?|variants?|covers?|editions?)\b/gi, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/** Drop a leading "The" and a trailing volume so facsimile series search uses the catalog name. */
export function facsimileSeriesBase(series: string): string {
  return series
    .replace(/\s*\((?:18|19|20)\d{2}(?:\s+series)?\)\s*$/i, "")
    .replace(/,?\s+\bvol(?:ume)?\.?\s*\d+\s*$/i, "")
    .replace(/^\s*the\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFacsimileSearches(series: string, issueNo: string): FacsimileSearch[] {
  const base = facsimileSeriesBase(series);
  if (!base || !/^\d+$/.test(issueNo)) return [];
  const rows: FacsimileSearch[] = [
    { series: `${base} Facsimile Edition`, issueNo },
    { series: `${base} Facsimile`, issueNo },
    { series: `${base} #${issueNo} Facsimile Edition`, issueNo: "1" },
    { series: `${base} ${issueNo} (Facsimile Edition)`, issueNo: "1" },
    { series: `${base} #${issueNo} (Facsimile Edition)`, issueNo: "1" },
  ];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.series.toLowerCase()}|${row.issueNo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scoreCandidate(copy: EditionCopy, candidate: MatchCandidate): MatchScore {
  const edition = detectEdition(copy);
  const candidateKind = kindFromText(`${candidate.seriesName} ${candidate.variant ?? ""}`);
  const copyBase = normName(edition.baseSeries);
  const candidateBase = normName(baseSeriesName(candidate.seriesName));
  let seriesPoints = 0;
  if (copyBase && candidateBase && copyBase === candidateBase) seriesPoints = 30;
  else if (seriesTitleFits(copy.series, candidate.seriesName) || seriesTitleFits(edition.baseSeries, candidate.seriesName)) seriesPoints = 30;
  else if (copyBase && candidateBase && (copyBase.includes(candidateBase) || candidateBase.includes(copyBase))) seriesPoints = 16;
  if (edition.kind !== "regular" && candidateKind === edition.kind) seriesPoints = 30;
  const printingOnSameIssue = edition.kind === "printing" && (candidateKind === "regular" || candidateKind === "printing");
  if (edition.kind !== candidateKind && !printingOnSameIssue) seriesPoints = Math.min(seriesPoints, 8);
  if (edition.kind === "printing") {
    const volumeFree = normName(facsimileSeriesBase(copy.series));
    if (volumeFree && candidateBase && volumeFree === candidateBase) seriesPoints = 30;
  }

  const wantedIssue =
    edition.kind === "facsimile" || edition.kind === "printing"
      ? edition.issueNo || stripIssueVariant(copy.issueNo).number
      : leadingIssue(copy.issueNo ?? "");
  const foundIssue = leadingIssue(candidate.issueNo);
  let issuePoints = 0;
  let blocked: string | null = null;
  if (wantedIssue && foundIssue) {
    const numbered = sameIssueNumber(wantedIssue, foundIssue);
    const facsimileNamed =
      edition.kind === "facsimile" &&
      seriesMentionsIssue(candidate.seriesName, wantedIssue) &&
      (sameIssueNumber(foundIssue, "1") || isUnnumberedIssue(foundIssue));
    if (numbered || facsimileNamed) issuePoints = 25;
    else blocked = "Issue numbers do not match.";
  }

  const shelfYears = shelfPublicationYears(copy);
  const catalogYears = catalogPublicationYears(candidate);
  const gap = closestYearGap(shelfYears, catalogYears);
  let yearPoints = shelfYears.length === 0 || catalogYears.length === 0 ? 8 : 0;
  if (gap != null) {
    if (gap <= 1) yearPoints = 20;
    else if (gap === 2) yearPoints = 10;
    else {
      yearPoints = 0;
      blocked = blocked ?? `Release years are ${gap} years apart (${yearGapDetail(copy, candidate)}).`;
    }
  }
  if (edition.kind === "printing" && (shelfYears.length === 0 || catalogYears.length === 0) && blocked == null) yearPoints = 20;
  if (edition.kind !== candidateKind && !printingOnSameIssue) {
    blocked = blocked ?? `This copy is ${KIND_LABEL[edition.kind]} and the catalog issue is ${KIND_LABEL[candidateKind]}.`;
  }
  if (edition.kind === "printing" && edition.printing != null) {
    const foundPrinting = printingNumberFromText(candidate.variant ?? "");
    if (foundPrinting != null && foundPrinting !== edition.printing) {
      blocked = blocked ?? `Catalog cover is a ${printingOrdinal(foundPrinting)} printing.`;
    }
  }
  if (edition.kind === "facsimile") {
    const copyDay = calendarDay(copy.releaseDate);
    const storeDay = calendarDay(candidate.storeDate);
    if (copyDay && storeDay) {
      const days = daysApart(copyDay, storeDay);
      if (days != null && days > FACSIMILE_DATE_WINDOW_DAYS) {
        blocked = blocked ?? `Store date is ${Math.round(days)} days from the release date.`;
      }
    }
    const release = yearOf(copy.releaseYear) ?? (copyDay ? Number(copyDay.slice(0, 4)) : null);
    const catalog = yearOf(candidate.releaseYear) ?? (storeDay ? Number(storeDay.slice(0, 4)) : null) ?? (yearOf(candidate.seriesYear) != null && candidateKind !== "regular" ? yearOf(candidate.seriesYear) : null);
    if (release != null && catalog != null && Math.abs(release - catalog) > 1) {
      const closeDates = copyDay && storeDay && (daysApart(copyDay, storeDay) ?? 999) <= FACSIMILE_DATE_WINDOW_DAYS;
      if (!closeDates) blocked = blocked ?? `Catalog year ${catalog} is not within a year of release year ${release}.`;
    }
    if (release != null && catalog == null) blocked = blocked ?? "Catalog issue has no store date.";
    if (copy.publisher && candidate.publisher && !publishersMatch(copy.publisher, candidate.publisher)) {
      blocked = blocked ?? "Publishers do not match.";
    }
  }

  const variantPoints = variantOverlap(copy, candidate) ? 10 : 0;
  const upcPoints = upcPointsFor(copy.barcode ?? null, candidate.upc);
  const publisherPoints = publishersMatch(copy.publisher ?? null, candidate.publisher) ? 8 : 0;
  const score = Math.min(100, seriesPoints + issuePoints + yearPoints + variantPoints + upcPoints + publisherPoints);
  return {
    score,
    auto: blocked == null && score >= AUTO_LINK_SCORE && issuePoints === 25,
    blocked,
    kind: edition.kind,
    candidateKind,
  };
}

export function suspectMatchReason(copy: EditionCopy & { metronIssueId?: string | null; gcdIssueId?: string | null }): string | null {
  if (!copy.metronIssueId && !copy.gcdIssueId) return null;
  const edition = detectEdition(copy);
  const release = yearOf(copy.releaseYear) ?? yearFromDay(calendarDay(copy.releaseDate));
  const cover = yearOf(copy.coverYear);
  if (edition.kind === "facsimile") {
    const catalog = yearOf(copy.catalogStoreYear);
    if (release != null && catalog != null && Math.abs(release - catalog) <= 1) return null;
    const parts = [...edition.reasons];
    if (release != null && catalog != null) parts.push(`Linked issue year ${catalog} is not within a year of release year ${release}.`);
    else parts.push("Linked issue store year is not within a year of the release date.");
    return parts.join(" ");
  }
  if (edition.kind === "printing" && edition.printing != null) {
    if (copy.catalogPrinting === edition.printing) return null;
    const parts = [...edition.reasons];
    parts.push(`The ${printingOrdinal(edition.printing)} printing cover has not been confirmed.`);
    return parts.join(" ");
  }
  const parts = [...edition.reasons];
  if (release != null && cover != null && Math.abs(release - cover) > 2 && !parts.some((part) => part.includes("Release year"))) {
    parts.push(`Release year ${release} and cover year ${cover} are ${Math.abs(release - cover)} years apart.`);
  }
  if (!edition.reprint && (release == null || cover == null || Math.abs(release - cover) <= 2)) return null;
  if (parts.length === 0) return null;
  return parts.join(" ");
}

function searchNames(kind: EditionKind, series: string, base: string): string[] {
  const names: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed && !names.some((name) => normName(name) === normName(trimmed))) names.push(trimmed);
  };
  if (kind === "facsimile" || kind === "reprint") add(`${base} Facsimile Edition`);
  if (kind === "true-believers") {
    add(`True Believers ${base}`);
    add(`${base} Facsimile Edition`);
  }
  if (kind === "omnibus") add(`${base} Omnibus`);
  if (kind === "anniversary") add(`${base} Anniversary`);
  if (kind === "reprint") add(`${base} Reprint`);
  add(series);
  if (kind !== "regular") add(base);
  if (kind === "printing") add(facsimileSeriesBase(series));
  return names;
}

export function kindFromText(value: string): EditionKind {
  const text = value.toLowerCase();
  if (/\btrue believers\b/.test(text)) return "true-believers";
  if (/\bfacsimiles?\b/.test(text)) return "facsimile";
  if (/\b(omnibus|compendium|absolute edition)\b/.test(text)) return "omnibus";
  if (/\banniversary\b/.test(text)) return "anniversary";
  if (/\breprints?\b/.test(text)) return "reprint";
  if (/(?:\b(?:second|third|fourth|fifth|sixth)\s+printing\b|\b(?:[2-9]|[1-9]\d)(?:st|nd|rd|th)\s+printing\b)/.test(text)) return "printing";
  return "regular";
}

export function baseSeriesName(series: string): string {
  return series
    .replace(/\s*\((?:18|19|20)\d{2}(?:\s+series)?\)\s*$/i, " ")
    .replace(/\bfacsimile edition\b/gi, " ")
    .replace(/\bfacsimiles?\b/gi, " ")
    .replace(/\btrue believers:?\b/gi, " ")
    .replace(/\banniversary edition\b/gi, " ")
    .replace(/\banniversary\b/gi, " ")
    .replace(/\breprint edition\b/gi, " ")
    .replace(/\breprints?\b/gi, " ")
    .replace(/\b(?:\d+)(?:st|nd|rd|th)\s+printing\b/gi, " ")
    .replace(/\b(?:second|third|fourth|fifth|sixth)\s+printing\b/gi, " ")
    .replace(/\bomnibus\b/gi, " ")
    .replace(/\bcompendium\b/gi, " ")
    .replace(/\babsolute edition\b/gi, " ")
    .replace(/[:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** CLZ cover year and release year. Purchase year and added year are not match anchors. */
function shelfPublicationYears(copy: EditionCopy): number[] {
  const years: number[] = [];
  const cover = yearOf(copy.coverYear);
  const release = yearOf(copy.releaseYear) ?? yearFromDay(calendarDay(copy.releaseDate));
  if (cover != null) years.push(cover);
  if (release != null && release !== cover) years.push(release);
  return years;
}

/**
 * Issue cover date and series year_began. A store date counts only when it sits
 * within two years of one of those, or when both are missing.
 */
function catalogPublicationYears(candidate: MatchCandidate): number[] {
  const cover = yearOf(candidate.coverYear);
  const series = yearOf(candidate.seriesYear);
  const store = yearOf(candidate.releaseYear);
  const years: number[] = [];
  if (cover != null) years.push(cover);
  if (series != null && series !== cover) years.push(series);
  const near = years.some((year) => store != null && Math.abs(year - store) <= 2);
  if (store != null && (near || years.length === 0) && !years.includes(store)) years.push(store);
  return years;
}

function closestYearGap(shelf: number[], catalog: number[]): number | null {
  if (shelf.length === 0 || catalog.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const left of shelf) {
    for (const right of catalog) best = Math.min(best, Math.abs(left - right));
  }
  return best;
}

function yearGapDetail(copy: EditionCopy, candidate: MatchCandidate): string {
  const parts: string[] = [];
  const cover = yearOf(copy.coverYear);
  const release = yearOf(copy.releaseYear) ?? yearFromDay(calendarDay(copy.releaseDate));
  const catalogCover = yearOf(candidate.coverYear);
  const series = yearOf(candidate.seriesYear);
  const store = yearOf(candidate.releaseYear);
  if (cover != null) parts.push(`shelf cover ${cover}`);
  if (release != null) parts.push(`shelf release ${release}`);
  if (catalogCover != null) parts.push(`catalog cover ${catalogCover}`);
  if (series != null) parts.push(`catalog series ${series}`);
  if (store != null && store !== catalogCover) parts.push(`catalog store ${store}`);
  return parts.join(", ");
}

function variantOverlap(copy: EditionCopy, candidate: MatchCandidate): boolean {
  const want = normName([copy.variant, copy.variantDescription].filter(Boolean).join(" "));
  const got = normName(candidate.variant ?? "");
  if (!want || !got) return false;
  return want.includes(got) || got.includes(want);
}

function upcPointsFor(barcode: string | null, upc: string | null): number {
  const left = digitsOnly(barcode);
  const right = digitsOnly(upc);
  if (left.length < 11 || right.length < 11) return 0;
  if (left === right) return 15;
  if (left.startsWith(right) || right.startsWith(left)) return 8;
  return 0;
}

function publishersMatch(wanted: string | null, found: string | null): boolean {
  const a = normName(wanted ?? "");
  const b = normName(found ?? "");
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function yearOf(value: number | null | undefined): number | null {
  if (value == null || !Number.isInteger(value)) return null;
  if (value < 1800 || value > 2200) return null;
  return value;
}

function leadingIssue(value: string): string {
  const match = value.trim().match(/^#?\s*(\d+[A-Za-z]?)/);
  return match?.[1] ?? value.trim();
}

export function seriesMentionsIssue(seriesName: string, issueNo: string): boolean {
  if (!/^\d+$/.test(issueNo)) return false;
  return new RegExp(`(?:#|\\b)${issueNo}\\b`, "i").test(seriesName);
}

/** GCD facsimile series often leave the issue number blank or `[nn]` and put it in the series title. */
export function isUnnumberedIssue(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" || trimmed === "[nn]" || trimmed === "nn";
}

export function calendarDay(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const match = String(value).match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

export function daysApart(left: string, right: string): number | null {
  const a = Date.parse(`${left}T12:00:00.000Z`);
  const b = Date.parse(`${right}T12:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b) / 86_400_000;
}

function yearFromDay(day: string | null): number | null {
  if (!day) return null;
  return yearOf(Number(day.slice(0, 4)));
}

/** "1", "01", and "1A" are the same issue. The letter is the CLZ variant suffix. */
export function sameIssueNumber(left: string, right: string): boolean {
  const a = issueNumberKey(left);
  const b = issueNumberKey(right);
  if (!a || !b) return false;
  return a === b;
}

function issueNumberKey(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^#\s*/, "");
  if (!trimmed) return "";
  const match = trimmed.match(/^(\d+)(?:\.0+)?[a-z]*$/);
  if (!match?.[1]) return trimmed;
  return String(Number(match[1]));
}

function digitsOnly(value: string | null): string {
  return (value ?? "").replace(/\D/g, "");
}

export function normName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^\s*the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
