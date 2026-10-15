export const SHELF_FORMATS = ["single", "tp", "hc", "omnibus", "gn", "compendium"] as const;

export type ShelfFormat = (typeof SHELF_FORMATS)[number];

export const SHELF_FORMAT_OPTIONS: Array<{ value: ShelfFormat; label: string; badge: string | null }> = [
  { value: "single", label: "Single Issue", badge: null },
  { value: "tp", label: "TP", badge: "TP" },
  { value: "hc", label: "HC", badge: "HC" },
  { value: "omnibus", label: "Omnibus", badge: "Omnibus" },
  { value: "gn", label: "Graphic Novel", badge: "GN" },
  { value: "compendium", label: "Compendium", badge: "Compendium" },
];

const EXPLICIT_SINGLE = /^(?:comic|comics|single(?:\s+issue)?|issue|floppy|periodical|magazine|annual|facsimile)$/i;
const VOLUME_TEXT = /^(?:vol(?:ume)?\.?\s*|v\.?\s*)(\d+)$/i;

export function isShelfFormat(value: string | null | undefined): value is ShelfFormat {
  return SHELF_FORMATS.includes(value as ShelfFormat);
}

export function shelfFormatOf(value: string | null | undefined): ShelfFormat {
  return isShelfFormat(value) ? value : "single";
}

export function isCollected(format: ShelfFormat): boolean {
  return format !== "single";
}

export function formatBadge(format: string | null | undefined): string | null {
  const parsed = isShelfFormat(format) ? format : null;
  if (!parsed || parsed === "single") return null;
  return SHELF_FORMAT_OPTIONS.find((option) => option.value === parsed)?.badge ?? null;
}

export function formatChoiceLabel(format: string | null | undefined): string {
  const parsed = shelfFormatOf(format);
  return SHELF_FORMAT_OPTIONS.find((option) => option.value === parsed)?.label ?? "Single Issue";
}

/** Metron series type name for a collected edition. Singles stay untyped. */
export function metronSeriesType(format: ShelfFormat): string | null {
  if (format === "hc") return "Hardcover";
  if (format === "omnibus") return "Omnibus";
  if (format === "tp" || format === "gn" || format === "compendium") return "Trade Paperback";
  return null;
}

/** Drop a trailing TP, HC, or collected-edition word so the catalog search uses the story series. */
export function tradeSearchSeries(series: string | null | undefined): string {
  return (series ?? "")
    .replace(/\s*[([].*?(?:tpb?|hc|omnibus|graphic novel|compendium).*?[)\]]\s*$/i, "")
    .replace(/\s*[,:]?\s*(?:tpb?|hc|omnibus|graphic novel|compendium)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Series names for comparison. CLZ often writes " - " where a catalog writes ": ".
 * Volumes are removed so "Vol. 1" can match a title that omits it, and compared separately.
 */
export function normalizeSeriesName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\bvol(?:ume)?\.?\s*\d+\b/g, " ")
    .replace(/\b(?:tpb|tp|hc)\b/g, " ")
    .replace(/[:\-–—'`.]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function seriesTokens(value: string | null | undefined): string[] {
  return normalizeSeriesName(value)
    .split(" ")
    .filter((token) => token && !/^(?:18|19|20)\d{2}$/.test(token));
}

function volumeToken(value: string | null | undefined): string | null {
  const match = (value ?? "").match(/\bvol(?:ume)?\.?\s*(\d+)\b/i);
  return match?.[1] ?? null;
}

/**
 * CLZ puts the volume and the year range on the series title. Metron stores those
 * on `volume` and `year_began`, and its name search requires every word.
 */
export function parseShelfSeries(series: string | null | undefined): {
  name: string;
  volume: number | null;
  yearBegan: number | null;
  yearEnd: number | null;
} {
  let name = (series ?? "").replace(/\s+/g, " ").trim();
  let volume: number | null = null;
  let yearBegan: number | null = null;
  let yearEnd: number | null = null;
  for (let pass = 0; pass < 4 && name; pass += 1) {
    const range = name.match(/^(.*?)(?:,)?\s+\(((?:18|19|20)\d{2})\s*[-–—]\s*((?:18|19|20)\d{2})\)\s*$/);
    if (range?.[1]?.trim()) {
      yearBegan = yearBegan ?? Number(range[2]);
      yearEnd = yearEnd ?? Number(range[3]);
      name = range[1].trim().replace(/,\s*$/, "");
      continue;
    }
    const single = name.match(/^(.*?)(?:,)?\s+\(((?:18|19|20)\d{2})(?:\s+series)?\)\s*$/);
    if (single?.[1]?.trim()) {
      yearBegan = yearBegan ?? Number(single[2]);
      name = single[1].trim().replace(/,\s*$/, "");
      continue;
    }
    const vol = name.match(/^(.*?)(?:,|\s)\s*vol(?:ume)?\.?\s*(\d+)\s*$/i);
    if (vol?.[1]?.trim()) {
      volume = volume ?? Number(vol[2]);
      name = vol[1].trim().replace(/,\s*$/, "");
      continue;
    }
    break;
  }
  return { name, volume, yearBegan, yearEnd };
}

/** Token-set match. A shared volume number has to agree when both titles carry one. */
export function seriesNamesMatch(wanted: string | null | undefined, found: string | null | undefined): boolean {
  const leftVol = volumeToken(wanted);
  const rightVol = volumeToken(found);
  if (leftVol && rightVol && leftVol !== rightVol) return false;
  const want = new Set(seriesTokens(wanted));
  const got = new Set(seriesTokens(found));
  if (want.size === 0 || got.size === 0) return false;
  let missing = 0;
  for (const token of want) if (!got.has(token)) missing += 1;
  let extra = 0;
  for (const token of got) if (!want.has(token)) extra += 1;
  if (missing === 0 && extra === 0) return true;
  if (want.size >= 4 && missing === 0 && extra <= 2) return true;
  if (want.size >= 5 && missing <= 1 && extra <= 1) return (want.size - missing) / want.size >= 0.8;
  return false;
}

/**
 * A one-word shelf name cannot fuzzy-match. A catalog title that ends with it
 * still counts ("Ewoks" and "Star Wars: Ewoks"). A title that only starts with
 * the name ("Saga" and "Saga of the Swamp Thing") does not.
 */
export function seriesTitleFits(wanted: string | null | undefined, found: string | null | undefined): boolean {
  if (seriesNamesMatch(wanted, found)) return true;
  const want = normalizeSeriesName(wanted);
  const got = normalizeSeriesName(found);
  if (!want || !got || want.length < 4) return false;
  if (want.split(" ").filter(Boolean).length >= 4) return false;
  return got.endsWith(` ${want}`);
}

/** Queries to send a catalog. Punctuation variants first, then a short prefix for long trade titles. */
export function catalogNameQueries(series: string | null | undefined, options?: { broad?: boolean }): string[] {
  const base = tradeSearchSeries(series);
  const queries: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length < 3) return;
    if (queries.some((query) => query.toLowerCase() === trimmed.toLowerCase())) return;
    queries.push(trimmed);
  };
  const colon = base.indexOf(":");
  if (colon >= 0) add(`${base.slice(0, colon)} ${base.slice(colon + 1)}`);
  add(base.replace(/\s+[-–—]\s+/g, ": "));
  add(base.replace(/[:\-–—'`.]/g, " "));
  add(base);
  if (options?.broad) {
    const words = base.replace(/[:\-–—'`.]/g, " ").split(/\s+/).filter(Boolean);
    if (words.length >= 5) add(words.slice(0, 3).join(" "));
  }
  return queries.slice(0, 5);
}

/** True when a Metron collected series title ends in TPB, HC, or the format word. */
export function metronCollectedTitle(name: string, format: ShelfFormat): boolean {
  const text = name.toLowerCase();
  if (format === "hc") return /\bhc\b|\bhardcover\b/.test(text);
  if (format === "omnibus") return /\bomnibus\b/.test(text);
  if (format === "compendium") return /\bcompendium\b/.test(text);
  if (format === "gn") return /\bgraphic novel\b|\bgn\b|\bogn\b/.test(text);
  return /\btpb\b|\btrade paperback\b|\btp\b/.test(text);
}

/** The volume digits from `1`, `Vol. 1`, or `Volume 1`. */
export function volumeNumber(issueNo: string | null | undefined, issue?: string | null): string | null {
  for (const raw of [issueNo, issue]) {
    const text = (raw ?? "").trim();
    if (!text) continue;
    const vol = VOLUME_TEXT.exec(text);
    if (vol) return String(Number(vol[1]));
    if (/^\d+$/.test(text)) return String(Number(text));
  }
  return null;
}

export function volumeLabel(issueNo: string | null | undefined, issue?: string | null): string {
  const number = volumeNumber(issueNo, issue);
  if (number) return `Vol. ${number}`;
  const raw = (issueNo ?? issue ?? "").trim();
  return raw || "Vol.";
}

/** ISBN-13 book barcodes start with 978 or 979. Comic UPC-A codes do not. */
export function isbnDigits(barcode: string | null | undefined): string | null {
  if (!barcode) return null;
  const digits = barcode.replace(/\D/g, "");
  if (digits.length === 13 && (digits.startsWith("978") || digits.startsWith("979"))) return digits;
  return null;
}

/** Digits-only ISBN, or the first 13 digits of a longer book barcode that starts with the ISBN. */
export function sameIsbn(wanted: string | null | undefined, ...found: Array<string | null | undefined>): boolean {
  const want = isbnDigits(wanted);
  if (!want) return false;
  for (const value of found) {
    const digits = (value ?? "").replace(/\D/g, "");
    if (!digits) continue;
    if (digits === want || (digits.length > 13 && digits.startsWith(want))) return true;
  }
  return false;
}

export function detectShelfFormat(input: {
  format?: string | null;
  series?: string | null;
  issue?: string | null;
  issueNo?: string | null;
  title?: string | null;
  fullTitle?: string | null;
  barcode?: string | null;
}): ShelfFormat {
  const fromFormat = formatFromText(input.format);
  if (fromFormat) return fromFormat;
  const fromName = formatFromText([input.series, input.title, input.fullTitle].filter(Boolean).join(" "));
  if (fromName && fromName !== "single") return fromName;
  const fromIssue = tradeIssueToken(input.issue) ?? tradeIssueToken(input.issueNo);
  if (fromIssue) return fromIssue;
  if (isVolumeNumber(input.issueNo) || isVolumeNumber(input.issue)) return "tp";
  if (isbnDigits(input.barcode)) return "tp";
  return "single";
}

/** Stored choice wins. A blank column falls back to the CLZ text and the series name. */
export function resolveShelfFormat(input: {
  shelfFormat?: string | null;
  format?: string | null;
  series?: string | null;
  issue?: string | null;
  issueNo?: string | null;
  title?: string | null;
  fullTitle?: string | null;
  barcode?: string | null;
}): ShelfFormat {
  if (input.shelfFormat != null && input.shelfFormat !== "") return shelfFormatOf(input.shelfFormat);
  return detectShelfFormat(input);
}

export function seriesHeaderFormat(formats: Array<string | null | undefined>): ShelfFormat | null {
  if (formats.length === 0) return null;
  const parsed = formats.map((format) => shelfFormatOf(format));
  const first = parsed[0];
  if (!first || first === "single") return null;
  return parsed.every((format) => format === first) ? first : null;
}

export function seriesLooksCollected(name: string, format: ShelfFormat): boolean {
  const text = name.toLowerCase();
  if (format === "hc") return /\bhc\b|hardcover|hard cover/.test(text);
  if (format === "omnibus") return /omnibus/.test(text);
  if (format === "compendium") return /compendium/.test(text);
  if (format === "gn") return /graphic novel|\bgn\b|\bogn\b/.test(text);
  return /\btpb?\b|trade paperback|graphic novel|compendium|omnibus|hardcover/.test(text);
}

export function gcdFormatMatches(publishingFormat: string | null | undefined, name: string, format: ShelfFormat): boolean {
  const text = `${publishingFormat ?? ""} ${name}`;
  if (isCollected(format) && /\bcollected edition\b/i.test(text)) return true;
  return seriesLooksCollected(text, format);
}

type CollectedItem = { series: string; number: string };

/** Turn catalog reprint rows into `Saga #1-6`. Empty when the payload has none. */
export function readCollectedIssues(value: unknown): string | null {
  const row = asRecord(value);
  if (!row) return null;
  const prose = proseCollected(row.collected_issues) ?? proseCollected(row.reprints) ?? proseCollected(row.reprint_notes) ?? proseCollected(row.collection);
  if (prose) return clip(prose);
  const items = itemsFrom(row.reprints) ?? itemsFrom(row.collected_issues) ?? itemsFromStories(row.story_set);
  if (!items || items.length === 0) return null;
  const list = formatCollectedList(items);
  return list ? clip(list) : null;
}

export function formatCollectedList(items: CollectedItem[]): string | null {
  if (items.length === 0) return null;
  const parts: string[] = [];
  let index = 0;
  while (index < items.length) {
    const series = items[index].series.trim();
    const start = wholeNumber(items[index].number);
    if (!series || start == null) {
      const number = items[index].number.trim();
      if (series && number) parts.push(`${series} #${number}`);
      index += 1;
      continue;
    }
    let end = start;
    let next = index + 1;
    while (next < items.length && items[next].series.trim() === series) {
      const value = wholeNumber(items[next].number);
      if (value == null || value !== end + 1) break;
      end = value;
      next += 1;
    }
    parts.push(start === end ? `${series} #${start}` : `${series} #${start}-${end}`);
    index = next;
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function wholeNumber(value: string | null | undefined): number | null {
  const text = (value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

function formatFromText(value: string | null | undefined): ShelfFormat | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (EXPLICIT_SINGLE.test(text)) return "single";
  if (/\bcompendium\b/i.test(text)) return "compendium";
  if (/\bomnibus\b/i.test(text)) return "omnibus";
  if (/\bgraphic novel\b|\bogn\b|\bgn\b/i.test(text)) return "gn";
  if (/\bhard\s*cover\b|\bhc\b/i.test(text)) return "hc";
  if (/\btrade paperback\b|\bpaperback\b|\bsoft\s*cover\b|\btpb\b|\btp\b/i.test(text)) return "tp";
  if (/\bcollected edition\b|\bcollection\b/i.test(text)) return "tp";
  if (/(?:^|[\s([,])tpb?(?:$|[\s)\],])/i.test(text)) return "tp";
  if (/(?:^|[\s([,])hc(?:$|[\s)\],])/i.test(text)) return "hc";
  return null;
}

function isVolumeNumber(value: string | null | undefined): boolean {
  return VOLUME_TEXT.test((value ?? "").trim());
}

/** CLZ stores a collected copy as issue TP, HC, or TPB in the same series as the singles. */
function tradeIssueToken(value: string | null | undefined): ShelfFormat | null {
  const text = (value ?? "").trim();
  if (/^hc$/i.test(text)) return "hc";
  if (/^tpb?$/i.test(text)) return "tp";
  return null;
}

function proseCollected(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "[]" || text === "{}") return null;
  return text;
}

function itemsFrom(value: unknown): CollectedItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: CollectedItem[] = [];
  for (const entry of value) {
    const item = itemFrom(entry);
    if (item) items.push(item);
  }
  return items;
}

function itemsFromStories(value: unknown): CollectedItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: CollectedItem[] = [];
  for (const entry of value) {
    const row = asRecord(entry);
    if (!row) continue;
    const prose = proseCollected(row.reprints) ?? proseCollected(row.reprint_notes);
    if (prose) {
      const parsed = itemFrom(prose);
      if (parsed) items.push(parsed);
    }
    const nested = itemsFrom(row.reprints);
    if (nested) items.push(...nested);
  }
  return items.length > 0 ? items : null;
}

function itemFrom(value: unknown): CollectedItem | null {
  if (typeof value === "string") {
    const match = value.trim().match(/^(.+?)\s+#\s*(\d+)\b/);
    if (!match) return null;
    return { series: match[1].trim(), number: match[2] };
  }
  const row = asRecord(value);
  if (!row) return null;
  const series = text(asRecord(row.series)?.name) ?? text(row.series) ?? text(row.series_name);
  const number = text(row.number) ?? text(row.issue_number) ?? text(row.issue);
  if (series && number && /^\d+$/.test(number)) return { series, number };
  const label = text(row.issue) ?? text(row.name);
  return label ? itemFrom(label) : null;
}

function clip(value: string): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
