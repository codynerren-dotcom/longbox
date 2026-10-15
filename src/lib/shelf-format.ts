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
  return seriesLooksCollected(`${publishingFormat ?? ""} ${name}`, format);
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
