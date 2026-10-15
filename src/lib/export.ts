import { CLZ_HEADERS, encodeCsv, type ClzHeader } from "@/lib/clz/headers";
import { APP_VERSION } from "@/lib/version";

const MODEL_FIELDS: Partial<Record<ClzHeader, string>> = {
  Series: "series",
  Issue: "issue",
  "Variant Description": "variantDescription",
  Publisher: "publisher",
  "Release Date": "releaseDate",
  Format: "format",
  "Added Date": "addedDate",
  "Issue No.": "issueNo",
  "Cover Date": "coverDate",
  Barcode: "barcode",
  "Story Arc": "storyArc",
  Grade: "grade",
  "Raw / Slabbed": "rawOrSlabbed",
  Key: "keyLevel",
  "Key Category": "keyCategory",
  "Key Reason": "keyReason",
  "Purchase Price": "purchasePrice",
  "Price Sold": "priceSold",
  "CovrPrice Value": "covrPriceValue",
  "Cover Price": "coverPrice",
  Notes: "notes",
  Quantity: "quantity",
  "Storage Box": "storageBox",
  Age: "age",
  "Core ComicID": "coreComicId",
  "Core SeriesID": "coreSeriesId",
  Country: "country",
  Crossover: "crossover",
  "Full Title": "fullTitle",
  Genre: "genre",
  Imprint: "imprint",
  Language: "language",
  "Release Year": "releaseYear",
  "Series Group": "seriesGroup",
  Subtitle: "subtitle",
  Title: "title",
  Variant: "variant",
  "Cover Year": "coverYear",
  "No. of Pages": "pageCount",
  "Added Year": "addedYear",
  "Bag/Board Date": "bagBoardDate",
  "Bag/Board Year": "bagBoardYear",
  "Collection Status": "collectionStatus",
  Index: "clzIndex",
  "Modified Date": "modifiedDate",
  "My Rating": "myRating",
  Owner: "owner",
  Plot: "plot",
  Read: "read",
  "Read Date": "readDate",
  "Read Year": "readYear",
  Tags: "tags",
  "Custom Label": "customLabel",
  "Grader Notes": "graderNotes",
  "Grading Company": "gradingCompany",
  "Label Type": "labelType",
  "My Value": "myValue",
  "Page Quality": "pageQuality",
  "Purchase Date": "purchaseDate",
  "Purchase Store": "purchaseStore",
  "Purchase Year": "purchaseYear",
  "Signed by": "signedBy",
  "Slab Certification Number": "slabCertNumber",
  "Sold Date": "soldDate",
  "Sold Year": "soldYear",
  Value: "value",
};

export function renderClzCsv(comics: Array<Record<string, unknown>>): string {
  const rows = comics.map((comic) => CLZ_HEADERS.map((header) => csvCell(comic, header)));
  return encodeCsv([[...CLZ_HEADERS], ...rows]);
}

export function toPlain(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (typeof value === "object") {
    const text = decimalText(value);
    if (text != null) return text;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = toPlain(item);
    return output;
  }
  return value;
}

export function buildBackup(input: {
  comics: unknown;
  wishlist: unknown;
  priceSnapshots: unknown;
  settings: Array<{ key: string; secret: string | null; plain: string | null }>;
  imports: unknown;
}): Record<string, unknown> {
  return {
    app: "longbox",
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    comics: toPlain(input.comics),
    wishlist: toPlain(input.wishlist),
    priceSnapshots: toPlain(input.priceSnapshots),
    settings: input.settings.map((row) => ({ key: row.key, secret: row.secret, plain: row.plain })),
    imports: toPlain(input.imports),
  };
}

function csvCell(comic: Record<string, unknown>, header: ClzHeader): string {
  const raw = rawCell(comic.rawRow, header);
  if (raw != null) return raw;
  const field = MODEL_FIELDS[header];
  if (!field) return "";
  return plainCell(comic[field]);
}

function rawCell(rawRow: unknown, header: string): string | null {
  if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) return null;
  if (!Object.prototype.hasOwnProperty.call(rawRow, header)) return null;
  return plainCell((rawRow as Record<string, unknown>)[header]);
}

function plainCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const decimal = typeof value === "object" ? decimalText(value) : null;
  if (decimal != null) return decimal;
  return String(value);
}

function decimalText(value: object): string | null {
  if (!("toFixed" in value) || typeof value.toFixed !== "function" || typeof value.toString !== "function") return null;
  const text = value.toString();
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}
