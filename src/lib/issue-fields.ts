export const RAW_CHOICES = ["Raw", "Slabbed"] as const;
export const KEY_LEVELS = ["No", "Minor", "Major"] as const;

export type IssueFieldKind =
  | "text"
  | "textarea"
  | "date"
  | "money"
  | "int"
  | "year"
  | "rating"
  | "quantity"
  | "bool"
  | "raw"
  | "keyLevel"
  | "category"
  | "company"
  | "box";

export type IssueFieldDef = {
  key: string;
  label: string;
  kind: IssueFieldKind;
  group: string;
  max?: number;
  full?: boolean;
};

export const ISSUE_FIELDS = [
  { key: "series", label: "Series", kind: "text", group: "Copy", max: 300 },
  { key: "issueNo", label: "Issue number", kind: "text", group: "Copy", max: 40 },
  { key: "issue", label: "Issue", kind: "text", group: "Copy", max: 40 },
  { key: "variant", label: "Variant", kind: "text", group: "Copy", max: 80 },
  { key: "variantDescription", label: "Variant description", kind: "text", group: "Copy", max: 200 },
  { key: "publisher", label: "Publisher", kind: "text", group: "Copy", max: 120 },
  { key: "format", label: "Format", kind: "text", group: "Copy", max: 80 },
  { key: "fullTitle", label: "Full title", kind: "text", group: "Copy", max: 300 },
  { key: "subtitle", label: "Subtitle", kind: "text", group: "Copy", max: 200 },
  { key: "seriesGroup", label: "Series group", kind: "text", group: "Copy", max: 120 },
  { key: "age", label: "Age", kind: "text", group: "Copy", max: 40 },
  { key: "country", label: "Country", kind: "text", group: "Copy", max: 80 },
  { key: "language", label: "Language", kind: "text", group: "Copy", max: 80 },
  { key: "genre", label: "Genre", kind: "text", group: "Copy", max: 80 },
  { key: "imprint", label: "Imprint", kind: "text", group: "Copy", max: 120 },
  { key: "crossover", label: "Crossover", kind: "text", group: "Copy", max: 200 },
  { key: "quantity", label: "Quantity", kind: "quantity", group: "Copy" },
  { key: "storageBox", label: "Storage box", kind: "box", group: "Copy", max: 80 },
  { key: "collectionStatus", label: "Collection status", kind: "text", group: "Copy", max: 80 },
  { key: "owner", label: "Owner", kind: "text", group: "Copy", max: 80 },
  { key: "customLabel", label: "Custom label", kind: "text", group: "Copy", max: 80 },
  { key: "tags", label: "Tags", kind: "text", group: "Copy", max: 200 },
  { key: "barcode", label: "Barcode", kind: "text", group: "Copy", max: 64 },
  { key: "keyLevel", label: "Key", kind: "keyLevel", group: "Key" },
  { key: "keyCategory", label: "Key category", kind: "category", group: "Key", max: 80 },
  { key: "keyReason", label: "Key reason", kind: "text", group: "Key", max: 300 },
  { key: "grade", label: "Grade", kind: "text", group: "Grade", max: 40 },
  { key: "rawOrSlabbed", label: "Raw or slab", kind: "raw", group: "Grade" },
  { key: "signedBy", label: "Signed by", kind: "text", group: "Grade", max: 200 },
  { key: "gradingCompany", label: "Grading company", kind: "company", group: "Slab", max: 40 },
  { key: "slabCertNumber", label: "Certification number", kind: "text", group: "Slab", max: 40 },
  { key: "labelType", label: "Label type", kind: "text", group: "Slab", max: 80 },
  { key: "pageQuality", label: "Page quality", kind: "text", group: "Slab", max: 80 },
  { key: "graderNotes", label: "Grader notes", kind: "textarea", group: "Slab", max: 8000, full: true },
  { key: "purchasePrice", label: "Purchase price", kind: "money", group: "Purchase" },
  { key: "purchaseDate", label: "Purchase date", kind: "date", group: "Purchase" },
  { key: "purchaseStore", label: "Purchase store", kind: "text", group: "Purchase", max: 120 },
  { key: "purchaseYear", label: "Purchase year", kind: "year", group: "Purchase" },
  { key: "priceSold", label: "Price sold", kind: "money", group: "Purchase" },
  { key: "soldDate", label: "Sold date", kind: "date", group: "Purchase" },
  { key: "soldYear", label: "Sold year", kind: "year", group: "Purchase" },
  { key: "myValue", label: "My value", kind: "money", group: "Purchase" },
  { key: "value", label: "Value", kind: "money", group: "Purchase" },
  { key: "covrPriceValue", label: "CovrPrice value", kind: "money", group: "Purchase" },
  { key: "coverPrice", label: "Cover price", kind: "money", group: "Purchase" },
  { key: "title", label: "Story title", kind: "text", group: "Story", max: 300 },
  { key: "storyArc", label: "Story arc", kind: "text", group: "Story", max: 300 },
  { key: "coverDate", label: "Cover date", kind: "text", group: "Story", max: 40 },
  { key: "coverYear", label: "Cover year", kind: "year", group: "Story" },
  { key: "releaseDate", label: "Release date", kind: "date", group: "Story" },
  { key: "releaseYear", label: "Release year", kind: "year", group: "Story" },
  { key: "pageCount", label: "Page count", kind: "int", group: "Story" },
  { key: "plot", label: "Plot", kind: "textarea", group: "Story", max: 8000, full: true },
  { key: "notes", label: "Notes", kind: "textarea", group: "Story", max: 8000, full: true },
  { key: "read", label: "Read", kind: "bool", group: "Read" },
  { key: "readDate", label: "Read date", kind: "date", group: "Read" },
  { key: "readYear", label: "Read year", kind: "year", group: "Read" },
  { key: "myRating", label: "My rating", kind: "rating", group: "Read" },
  { key: "addedDate", label: "Added date", kind: "date", group: "Read" },
  { key: "addedYear", label: "Added year", kind: "year", group: "Read" },
  { key: "bagBoardDate", label: "Bag and board date", kind: "date", group: "Read" },
  { key: "bagBoardYear", label: "Bag and board year", kind: "year", group: "Read" },
  { key: "modifiedDate", label: "Modified date", kind: "date", group: "Read" },
  { key: "writer", label: "Writer", kind: "text", group: "Creators", max: 500 },
  { key: "artist", label: "Artist", kind: "text", group: "Creators", max: 500 },
  { key: "coverArtist", label: "Cover artist", kind: "text", group: "Creators", max: 500 },
  { key: "characters", label: "Characters", kind: "textarea", group: "Creators", max: 8000, full: true },
  { key: "teams", label: "Teams", kind: "textarea", group: "Creators", max: 8000, full: true },
  { key: "seriesYear", label: "Series year", kind: "year", group: "Creators" },
  { key: "seriesVolume", label: "Series volume", kind: "int", group: "Creators" },
  { key: "coreComicId", label: "Core ComicID", kind: "text", group: "Catalog", max: 40 },
  { key: "coreSeriesId", label: "Core SeriesID", kind: "text", group: "Catalog", max: 40 },
  { key: "clzIndex", label: "Index", kind: "text", group: "Catalog", max: 40 },
  { key: "metronIssueId", label: "Metron issue id", kind: "text", group: "Catalog", max: 20 },
  { key: "metronSeriesId", label: "Metron series id", kind: "text", group: "Catalog", max: 20 },
  { key: "comicvineIssueId", label: "Comic Vine issue id", kind: "text", group: "Catalog", max: 20 },
  { key: "comicvineSeriesId", label: "Comic Vine series id", kind: "text", group: "Catalog", max: 20 },
] as const satisfies readonly IssueFieldDef[];

export type IssueFieldKey = (typeof ISSUE_FIELDS)[number]["key"];

export type IssueDraft = {
  id: string;
  values: Record<IssueFieldKey, string>;
};

const MONEY = new Set<IssueFieldKey>(["purchasePrice", "priceSold", "covrPriceValue", "coverPrice", "myValue", "value"]);
const DATES = new Set<IssueFieldKey>([
  "releaseDate",
  "addedDate",
  "bagBoardDate",
  "modifiedDate",
  "readDate",
  "purchaseDate",
  "soldDate",
]);
const INTS = new Set<IssueFieldKey>([
  "quantity",
  "pageCount",
  "seriesVolume",
  "coverYear",
  "releaseYear",
  "seriesYear",
  "addedYear",
  "bagBoardYear",
  "readYear",
  "purchaseYear",
  "soldYear",
]);

const HELD_WITH: Partial<Record<IssueFieldKey, readonly string[]>> = {
  series: ["seriesSort"],
  issueNo: ["issueSort"],
  releaseDate: ["releaseYear"],
  addedDate: ["addedYear"],
  bagBoardDate: ["bagBoardYear"],
  readDate: ["readYear"],
  purchaseDate: ["purchaseYear"],
  soldDate: ["soldYear"],
  coverDate: ["coverYear"],
};

export function fieldByKey(key: string): IssueFieldDef | undefined {
  return ISSUE_FIELDS.find((field) => field.key === key);
}

export function fieldLabel(key: string): string {
  return fieldByKey(key)?.label ?? key;
}

export function issueGroups(): string[] {
  const groups: string[] = [];
  for (const field of ISSUE_FIELDS) {
    if (!groups.includes(field.group)) groups.push(field.group);
  }
  return groups;
}

export function choiceList(preset: readonly string[], current: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...preset, current]) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function issueLabel(series: string, issueNo: string | null | undefined): string {
  const name = series.trim() || "Issue";
  return issueNo?.trim() ? `${name} #${issueNo.trim()}` : name;
}

export function canonical(field: string, value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  const text = typeof value === "string" ? value.trim() : valueToString(value);
  if (!text) return "";
  const key = field as IssueFieldKey;
  if (MONEY.has(key) || key === "myRating") {
    const amount = Number(text);
    return Number.isFinite(amount) ? amount.toFixed(2) : text;
  }
  if (INTS.has(key)) {
    const amount = Number(text);
    return Number.isFinite(amount) ? String(Math.trunc(amount)) : text;
  }
  if (DATES.has(key) && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text;
}

export function sameStored(field: string, current: unknown, next: unknown): boolean {
  return canonical(field, current) === canonical(field, next);
}

export function toIssueDraft(comic: { id: string } & Record<string, unknown>): IssueDraft {
  const values = {} as Record<IssueFieldKey, string>;
  for (const field of ISSUE_FIELDS) {
    values[field.key] = displayValue(field.key, comic[field.key]);
  }
  return { id: comic.id, values };
}

export function displayValue(field: string, value: unknown): string {
  const text = canonical(field, value);
  if (!text) return "";
  if (field === "myRating") {
    const amount = Number(text);
    return Number.isInteger(amount) ? String(amount) : text.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (MONEY.has(field as IssueFieldKey)) return text;
  return text;
}

function valueToString(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (value && typeof value === "object" && "toString" in value) {
    const text = String(value);
    return text === "[object Object]" ? "" : text.trim();
  }
  return "";
}

export function heldCompanions(field: string): readonly string[] {
  return HELD_WITH[field as IssueFieldKey] ?? [];
}
