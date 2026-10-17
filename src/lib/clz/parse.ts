import { CLZ_HEADERS, type ClzHeader } from "@/lib/clz/headers";
import { parseCsv } from "@/lib/clz/csv";
import { canonicalIsbn, detectShelfFormat, volumeNumber, type ShelfFormat } from "@/lib/shelf-format";

export class ClzParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClzParseError";
  }
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export type NormalizedComic = {
  dedupeKey: string;
  coreComicId: string | null;
  coreSeriesId: string | null;
  clzIndex: string | null;
  series: string;
  seriesSort: string;
  issue: string | null;
  issueNo: string | null;
  issueSort: number | null;
  variantDescription: string | null;
  variant: string | null;
  publisher: string | null;
  releaseDate: Date | null;
  format: string | null;
  shelfFormat: ShelfFormat;
  addedDate: Date | null;
  coverDate: string | null;
  barcode: string | null;
  isbn: string | null;
  storyArc: string | null;
  grade: string | null;
  rawOrSlabbed: string | null;
  keyLevel: string | null;
  keyCategory: string | null;
  keyReason: string | null;
  purchasePrice: string | null;
  priceSold: string | null;
  covrPriceValue: string | null;
  coverPrice: string | null;
  notes: string | null;
  quantity: number;
  storageBox: string | null;
  age: string | null;
  country: string | null;
  crossover: string | null;
  fullTitle: string | null;
  genre: string | null;
  imprint: string | null;
  language: string | null;
  releaseYear: number | null;
  seriesGroup: string | null;
  subtitle: string | null;
  title: string | null;
  coverYear: number | null;
  pageCount: number | null;
  addedYear: number | null;
  bagBoardDate: Date | null;
  bagBoardYear: number | null;
  collectionStatus: string | null;
  modifiedDate: Date | null;
  myRating: string | null;
  owner: string | null;
  plot: string | null;
  read: boolean;
  readDate: Date | null;
  readYear: number | null;
  tags: string | null;
  customLabel: string | null;
  graderNotes: string | null;
  gradingCompany: string | null;
  labelType: string | null;
  myValue: string | null;
  pageQuality: string | null;
  purchaseDate: Date | null;
  purchaseStore: string | null;
  purchaseYear: number | null;
  signedBy: string | null;
  slabCertNumber: string | null;
  soldDate: Date | null;
  soldYear: number | null;
  value: string | null;
  rawRow: Record<ClzHeader, string>;
};

export type ClzParseResult = {
  comics: NormalizedComic[];
  warnings: string[];
};

function cell(record: Record<string, string>, header: ClzHeader): string {
  return record[header] ?? "";
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Calendar dates such as `Feb 26, 2020`. `0000-00-00` is null. Never uses local TZ. */
export function parseClzDate(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0000-00-00" || trimmed.startsWith("0000-")) return null;

  const monthName = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(trimmed);
  if (monthName) {
    const month = MONTHS[monthName[1].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    const day = Number(monthName[2]);
    const year = Number(monthName[3]);
    if (day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month, day, 12, 0, 0));
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (year === 0 || month === 0 || day === 0) return null;
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }

  return null;
}

/**
 * CLZ purchase price is per copy. Cost basis is that unit price times quantity.
 * Returns a 2-decimal string, or null when there is no price.
 */
export function costBasis(
  price: { toString(): string } | string | null | undefined,
  quantity: number,
): string | null {
  if (price == null || price === "") return null;
  const text = price.toString().trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const copies = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  let cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (Number(fraction[2] ?? "0") >= 5) cents += 1;
  const total = cents * copies;
  const sign = negative ? "-" : "";
  return `${sign}${Math.floor(total / 100)}.${String(total % 100).padStart(2, "0")}`;
}

/** `$ 4.99`, `$4.99`, `$ 1,250.00`. Returned as a decimal string. */
export function parseClzPrice(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.trim().replace(/[$,\s]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "—") return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = `${fraction}00`.slice(0, 2);
  return `${negative ? "-" : ""}${whole}.${cents}`;
}

/** `2020.0` and `32` become integers. Anything else is null. */
export function parseClzWholeNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^-?\d+(\.0+)?$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whole numbers rendered as `1.0` collapse to `1`. `1.5` stays `1.5`. */
export function normalizeNumericText(value: string | null | undefined): string | null {
  const trimmed = blankToNull(value ?? "");
  if (!trimmed) return null;
  if (/^-?\d+\.0+$/.test(trimmed)) return String(Number.parseInt(trimmed, 10));
  return trimmed;
}

/**
 * Barcodes stay strings. Digit-only cells (optional spaces or dashes) are
 * compacted, which keeps leading zeros. This function never calls Number().
 */
export function parseClzBarcode(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[\d\s-]+$/.test(trimmed)) return trimmed.replace(/[\s-]/g, "");
  return trimmed;
}

function parseYesNo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "yes" || normalized === "y" || normalized === "true" || normalized === "1";
}

function parseKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized === "no" || normalized === "n") return "No";
  if (normalized === "minor") return "Minor";
  if (normalized === "major") return "Major";
  return trimmed;
}

function parseRawOrSlabbed(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized === "raw") return "Raw";
  if (normalized === "slabbed" || normalized === "slab") return "Slabbed";
  return trimmed;
}

export function issueNumberValue(issueNo: string | null | undefined): number | null {
  if (!issueNo) return null;
  if (!/^\d+$/.test(issueNo)) return null;
  const parsed = Number.parseInt(issueNo, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberedVolume(issueNo: string | null, issue: string | null): number | null {
  const volume = volumeNumber(issueNo, issue);
  return volume ? Number(volume) : null;
}

/**
 * A usable CLZ core id is a positive integer. `0`, `0.0`, blanks, and
 * anything that is not an integer are missing ids, not a shared comic.
 */
export function usableCoreId(value: string | null | undefined): string | null {
  const normalized = normalizeNumericText(value);
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  if (/^0+$/.test(normalized)) return null;
  return normalized;
}

export function dedupeKeyFor(parts: {
  coreComicId: string | null;
  variant: string | null;
  clzIndex: string | null;
  series: string;
  issue: string | null;
  issueNo: string | null;
  barcode: string | null;
}): string {
  const variant = (parts.variant ?? "").trim().toLowerCase();
  const index = parts.clzIndex ?? "";
  const coreId = usableCoreId(parts.coreComicId);
  if (coreId) {
    return `core:${coreId}|var:${variant}|idx:${index}`;
  }
  const issueLabel = (parts.issue ?? "").trim().toLowerCase();
  const issueNo = (parts.issueNo ?? "").trim().toLowerCase();
  const issue = issueLabel && issueNo && issueLabel !== issueNo ? `${issueLabel}#${issueNo}` : issueLabel || issueNo;
  return `fallback:${parts.series.trim().toLowerCase()}|${issue}|${variant}|${parts.barcode ?? ""}|${index}`;
}

export function normalizeClzRecord(record: Record<string, string>): NormalizedComic {
  const rawRow = {} as Record<ClzHeader, string>;
  for (const header of CLZ_HEADERS) rawRow[header] = cell(record, header);

  const series = cell(record, "Series").trim() || "Untitled";
  const issue = normalizeNumericText(cell(record, "Issue"));
  const issueNo = normalizeNumericText(cell(record, "Issue No."));
  const variant = blankToNull(cell(record, "Variant"));
  const clzIndex = normalizeNumericText(cell(record, "Index"));
  const coreComicId = usableCoreId(cell(record, "Core ComicID"));
  const barcode = parseClzBarcode(cell(record, "Barcode"));
  const quantity = parseClzWholeNumber(cell(record, "Quantity"));

  return {
    dedupeKey: dedupeKeyFor({
      coreComicId: cell(record, "Core ComicID"),
      variant,
      clzIndex,
      series,
      issue,
      issueNo,
      barcode,
    }),
    coreComicId,
    coreSeriesId: usableCoreId(cell(record, "Core SeriesID")),
    clzIndex,
    series,
    seriesSort: series.toLowerCase(),
    issue,
    issueNo,
    issueSort: issueNumberValue(issueNo) ?? numberedVolume(issueNo, issue),
    variantDescription: blankToNull(cell(record, "Variant Description")),
    variant,
    publisher: blankToNull(cell(record, "Publisher")),
    releaseDate: parseClzDate(cell(record, "Release Date")),
    format: blankToNull(cell(record, "Format")),
    shelfFormat: detectShelfFormat({
      format: blankToNull(cell(record, "Format")),
      series,
      issue,
      issueNo,
      title: blankToNull(cell(record, "Title")),
      fullTitle: blankToNull(cell(record, "Full Title")),
      barcode,
    }),
    addedDate: parseClzDate(cell(record, "Added Date")),
    coverDate: blankToNull(cell(record, "Cover Date")),
    barcode,
    isbn: canonicalIsbn(barcode),
    storyArc: blankToNull(cell(record, "Story Arc")),
    grade: normalizeNumericText(cell(record, "Grade")),
    rawOrSlabbed: parseRawOrSlabbed(cell(record, "Raw / Slabbed")),
    keyLevel: parseKey(cell(record, "Key")),
    keyCategory: blankToNull(cell(record, "Key Category")),
    keyReason: blankToNull(cell(record, "Key Reason")),
    purchasePrice: parseClzPrice(cell(record, "Purchase Price")),
    priceSold: parseClzPrice(cell(record, "Price Sold")),
    covrPriceValue: parseClzPrice(cell(record, "CovrPrice Value")),
    coverPrice: parseClzPrice(cell(record, "Cover Price")),
    notes: blankToNull(cell(record, "Notes")),
    quantity: quantity && quantity > 0 ? quantity : 1,
    storageBox: blankToNull(cell(record, "Storage Box")),
    age: normalizeNumericText(cell(record, "Age")),
    country: blankToNull(cell(record, "Country")),
    crossover: blankToNull(cell(record, "Crossover")),
    fullTitle: blankToNull(cell(record, "Full Title")),
    genre: blankToNull(cell(record, "Genre")),
    imprint: blankToNull(cell(record, "Imprint")),
    language: blankToNull(cell(record, "Language")),
    releaseYear: parseClzWholeNumber(cell(record, "Release Year")),
    seriesGroup: blankToNull(cell(record, "Series Group")),
    subtitle: blankToNull(cell(record, "Subtitle")),
    title: blankToNull(cell(record, "Title")),
    coverYear: parseClzWholeNumber(cell(record, "Cover Year")),
    pageCount: parseClzWholeNumber(cell(record, "No. of Pages")),
    addedYear: parseClzWholeNumber(cell(record, "Added Year")),
    bagBoardDate: parseClzDate(cell(record, "Bag/Board Date")),
    bagBoardYear: parseClzWholeNumber(cell(record, "Bag/Board Year")),
    collectionStatus: blankToNull(cell(record, "Collection Status")),
    modifiedDate: parseClzDate(cell(record, "Modified Date")),
    myRating: parseClzPrice(cell(record, "My Rating")),
    owner: blankToNull(cell(record, "Owner")),
    plot: blankToNull(cell(record, "Plot")),
    read: parseYesNo(cell(record, "Read")),
    readDate: parseClzDate(cell(record, "Read Date")),
    readYear: parseClzWholeNumber(cell(record, "Read Year")),
    tags: blankToNull(cell(record, "Tags")),
    customLabel: blankToNull(cell(record, "Custom Label")),
    graderNotes: blankToNull(cell(record, "Grader Notes")),
    gradingCompany: blankToNull(cell(record, "Grading Company")),
    labelType: blankToNull(cell(record, "Label Type")),
    myValue: parseClzPrice(cell(record, "My Value")),
    pageQuality: blankToNull(cell(record, "Page Quality")),
    purchaseDate: parseClzDate(cell(record, "Purchase Date")),
    purchaseStore: blankToNull(cell(record, "Purchase Store")),
    purchaseYear: parseClzWholeNumber(cell(record, "Purchase Year")),
    signedBy: blankToNull(cell(record, "Signed by")),
    slabCertNumber: blankToNull(cell(record, "Slab Certification Number")),
    soldDate: parseClzDate(cell(record, "Sold Date")),
    soldYear: parseClzWholeNumber(cell(record, "Sold Year")),
    value: parseClzPrice(cell(record, "Value")),
    rawRow,
  };
}

export function assertClzHeader(header: string[]): void {
  const sameLength = header.length === CLZ_HEADERS.length;
  const sameOrder = sameLength && header.every((name, index) => name === CLZ_HEADERS[index]);
  if (sameOrder) return;
  const missing = CLZ_HEADERS.filter((name) => !header.includes(name));
  const unexpected = header.filter((name) => !(CLZ_HEADERS as readonly string[]).includes(name));
  throw new ClzParseError(
    `CLZ header mismatch. Expected ${CLZ_HEADERS.length} columns in the official order. Missing: ${
      missing.join(", ") || "none"
    }. Unexpected: ${unexpected.join(", ") || "none"}.`,
  );
}

export function parseClzCsv(text: string): ClzParseResult {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    throw new ClzParseError(error instanceof Error ? error.message : "Could not read the CSV.");
  }
  if (table.length === 0) throw new ClzParseError("The CSV is empty.");
  const [header, ...body] = table;
  assertClzHeader(header);

  const warnings: string[] = [];
  const comics: NormalizedComic[] = [];
  body.forEach((cells, index) => {
    if (cells.length !== CLZ_HEADERS.length) {
      throw new ClzParseError(
        `Row ${index + 2} has ${cells.length} columns; expected ${CLZ_HEADERS.length}.`,
      );
    }
    const record: Record<string, string> = {};
    CLZ_HEADERS.forEach((name, cellIndex) => {
      record[name] = cells[cellIndex] ?? "";
    });
    if (!record.Series.trim() && !record["Core ComicID"].trim()) {
      warnings.push(`Skipped blank row ${index + 2}.`);
      return;
    }
    comics.push(normalizeClzRecord(record));
  });

  return { comics, warnings };
}

/** Last row wins so a re-export later in the file replaces the earlier copy. */
export function mergeByDedupeKey(comics: NormalizedComic[]): NormalizedComic[] {
  const map = new Map<string, NormalizedComic>();
  for (const comic of comics) map.set(comic.dedupeKey, comic);
  return [...map.values()];
}

export function planImport(existingKeys: Set<string>, comics: NormalizedComic[]) {
  const merged = mergeByDedupeKey(comics);
  let create = 0;
  let update = 0;
  for (const comic of merged) {
    if (existingKeys.has(comic.dedupeKey)) update += 1;
    else create += 1;
  }
  return {
    merged,
    create,
    update,
    collapsed: comics.length - merged.length,
  };
}
