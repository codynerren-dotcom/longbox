import { issueNumberValue, parseClzDate, parseClzPrice } from "@/lib/clz/parse";
import { readFieldSources, type FieldSources } from "@/lib/covers/enrich";
import { canonicalIsbn, isShelfFormat, volumeNumber } from "@/lib/shelf-format";
import {
  ISSUE_FIELDS,
  KEY_LEVELS,
  RAW_CHOICES,
  fieldByKey,
  fieldLabel,
  heldCompanions,
  sameStored,
  type IssueFieldKey,
} from "@/lib/issue-fields";

export type IssueFieldError = { field: string; message: string };

export type IssueChoiceLists = {
  categories: string[];
  companies: string[];
  rawOrSlabbed: string[];
  keyLevels: string[];
};

export type UserConflict = { field: string; label: string };

const DATE_YEARS: ReadonlyArray<readonly [IssueFieldKey, IssueFieldKey]> = [
  ["purchaseDate", "purchaseYear"],
  ["soldDate", "soldYear"],
  ["releaseDate", "releaseYear"],
  ["addedDate", "addedYear"],
  ["bagBoardDate", "bagBoardYear"],
  ["readDate", "readYear"],
];

export function emptyChoiceLists(): IssueChoiceLists {
  return {
    categories: [],
    companies: [],
    rawOrSlabbed: [...RAW_CHOICES],
    keyLevels: [...KEY_LEVELS],
  };
}

export function parseIssueForm(
  raw: Record<string, string>,
  lists: IssueChoiceLists,
): { ok: true; values: Record<IssueFieldKey, unknown> } | { ok: false; errors: IssueFieldError[] } {
  const errors: IssueFieldError[] = [];
  const values = {} as Record<IssueFieldKey, unknown>;
  for (const field of ISSUE_FIELDS) {
    const text = String(raw[field.key] ?? "");
    values[field.key] = readField(field.key, text, lists, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  fillDerivedYears(values);
  return { ok: true, values };
}

export function planIssueEdit(
  current: object,
  raw: Record<string, string>,
  fieldSources: unknown,
  lists: IssueChoiceLists,
):
  | { ok: true; data: Record<string, unknown>; sources: FieldSources; changed: string[] }
  | { ok: false; errors: IssueFieldError[] } {
  const parsed = parseIssueForm(raw, lists);
  if (!parsed.ok) return parsed;
  const row = current as Record<string, unknown>;
  const sources = readFieldSources(fieldSources);
  const data: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const field of ISSUE_FIELDS) {
    const next = parsed.values[field.key];
    if (sameStored(field.key, row[field.key], next)) continue;
    data[field.key] = next;
    sources[field.key] = "user";
    changed.push(field.label);
  }
  if ("barcode" in data && (row.isbn == null || row.isbn === "") && !("isbn" in data)) {
    const next = canonicalIsbn(typeof data.barcode === "string" ? data.barcode : null);
    if (next) {
      data.isbn = next;
      sources.isbn = "user";
      changed.push("ISBN");
    }
  }
  if (changed.length === 0) return { ok: true, data: {}, sources, changed };
  if ("series" in data && typeof data.series === "string") data.seriesSort = data.series.toLowerCase();
  if ("issueNo" in data || "issue" in data) {
    const issueNo = "issueNo" in data ? data.issueNo : row.issueNo;
    const issue = "issue" in data ? data.issue : row.issue;
    const numeric = issueNumberValue(issueNo == null ? null : String(issueNo));
    const volume = volumeNumber(issueNo == null ? null : String(issueNo), issue == null ? null : String(issue));
    data.issueSort = numeric ?? (volume ? Number(volume) : null);
  }
  data.fieldSources = sources;
  return { ok: true, data, sources, changed };
}

/** Drop CLZ values for fields a person edited. Equal values are not a conflict. */
export function holdUserEdits<T extends Record<string, unknown>>(
  update: T,
  current: object | null,
  fieldSources: unknown,
): { update: T; conflicts: UserConflict[] } {
  const sources = readFieldSources(fieldSources);
  const next = { ...update };
  const conflicts: UserConflict[] = [];
  const row = current as Record<string, unknown> | null;
  if (!row) return { update: next, conflicts };
  for (const field of Object.keys(sources)) {
    if (sources[field] !== "user" || !(field in next)) continue;
    if (!sameStored(field, row[field], next[field])) {
      conflicts.push({ field, label: fieldLabel(field) });
    }
    delete next[field];
    for (const companion of heldCompanions(field)) delete next[companion];
  }
  return { update: next, conflicts };
}

export function conflictMessage(series: string, issueNo: string | null, conflicts: UserConflict[]): string {
  const name = `${series.trim() || "Issue"}${issueNo?.trim() ? ` #${issueNo.trim()}` : ""}`;
  const fields = conflicts.map((conflict) => conflict.label).join(", ");
  return `CLZ re-import skipped user edits on ${name}: ${fields}.`;
}

function readField(key: IssueFieldKey, text: string, lists: IssueChoiceLists, errors: IssueFieldError[]): unknown {
  const field = fieldByKey(key);
  const label = field?.label ?? key;
  const trimmed = text.trim();
  if (key === "isbn") return trimmed ? canonicalIsbn(trimmed) ?? trimmed.slice(0, field?.max ?? 17) : null;
  if (field?.kind === "bool") return trimmed === "true";
  if (field?.kind === "quantity") return readQuantity(key, trimmed, label, errors);
  if (field?.kind === "shelfFormat") {
    if (!trimmed) return "single";
    if (!isShelfFormat(trimmed)) {
      errors.push({ field: key, message: "Choose a format from the list." });
      return null;
    }
    return trimmed;
  }
  if (!trimmed) {
    if (key === "series") errors.push({ field: key, message: "Series is required." });
    return null;
  }
  if (field?.max && trimmed.length > field.max) {
    errors.push({ field: key, message: `${label} is too long.` });
    return null;
  }
  switch (field?.kind) {
    case "date":
      return readDate(key, trimmed, label, errors);
    case "money":
      return readMoney(key, trimmed, label, errors);
    case "year":
      return readYear(key, trimmed, label, errors);
    case "int":
      return readInt(key, trimmed, label, errors);
    case "rating":
      return readRating(key, trimmed, label, errors);
    case "raw":
      return readChoice(key, trimmed, label, lists.rawOrSlabbed, errors);
    case "keyLevel":
      return readChoice(key, trimmed, label, lists.keyLevels, errors);
    case "category":
      return readChoice(key, trimmed, label, lists.categories, errors);
    case "company":
      return readChoice(key, trimmed, label, lists.companies, errors);
    default:
      return trimmed;
  }
}

function readQuantity(key: string, text: string, label: string, errors: IssueFieldError[]): number | null {
  if (!/^\d+$/.test(text)) {
    errors.push({ field: key, message: `${label} has to be a whole number.` });
    return null;
  }
  const value = Number(text);
  if (value < 1 || value > 9999) {
    errors.push({ field: key, message: `${label} has to be from 1 to 9999.` });
    return null;
  }
  return value;
}

function readDate(key: string, text: string, label: string, errors: IssueFieldError[]): Date | null {
  const date = parseClzDate(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const shifted =
    date != null &&
    iso != null &&
    (date.getUTCFullYear() !== Number(iso[1]) || date.getUTCMonth() + 1 !== Number(iso[2]) || date.getUTCDate() !== Number(iso[3]));
  if (!date || shifted) {
    errors.push({ field: key, message: `Enter a real ${label.toLowerCase()}.` });
    return null;
  }
  return date;
}

function readMoney(key: string, text: string, label: string, errors: IssueFieldError[]): string | null {
  const price = parseClzPrice(text);
  if (!price || price.startsWith("-")) {
    errors.push({ field: key, message: `Enter ${label.toLowerCase()} like 4.99.` });
    return null;
  }
  return price;
}

function readYear(key: string, text: string, label: string, errors: IssueFieldError[]): number | null {
  if (!/^\d{4}$/.test(text)) {
    errors.push({ field: key, message: `${label} has to be a four-digit year.` });
    return null;
  }
  const year = Number(text);
  if (year < 1800 || year > 2100) {
    errors.push({ field: key, message: `${label} has to be from 1800 to 2100.` });
    return null;
  }
  return year;
}

function readInt(key: string, text: string, label: string, errors: IssueFieldError[]): number | null {
  if (!/^\d+$/.test(text)) {
    errors.push({ field: key, message: `${label} has to be a whole number.` });
    return null;
  }
  const value = Number(text);
  if (value < 1 || value > 100000) {
    errors.push({ field: key, message: `${label} has to be from 1 to 100000.` });
    return null;
  }
  return value;
}

function readRating(key: string, text: string, label: string, errors: IssueFieldError[]): string | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    errors.push({ field: key, message: `${label} has to be a number from 0 to 10.` });
    return null;
  }
  const value = Number(text);
  if (value < 0 || value > 10) {
    errors.push({ field: key, message: `${label} has to be from 0 to 10.` });
    return null;
  }
  return value.toFixed(2);
}

function readChoice(key: string, text: string, label: string, allowed: readonly string[], errors: IssueFieldError[]): string | null {
  if (!allowed.includes(text)) {
    errors.push({ field: key, message: `Choose a ${label.toLowerCase()} from the list.` });
    return null;
  }
  return text;
}

function fillDerivedYears(values: Record<IssueFieldKey, unknown>) {
  for (const [dateKey, yearKey] of DATE_YEARS) {
    if (values[yearKey] != null) continue;
    const date = values[dateKey];
    if (date instanceof Date) values[yearKey] = date.getUTCFullYear();
  }
  if (values.coverYear == null && typeof values.coverDate === "string") {
    const match = values.coverDate.match(/\b(18|19|20)\d{2}\b/);
    if (match) values.coverYear = Number(match[0]);
  }
}

export function blankIssueRaw(overrides: Partial<Record<IssueFieldKey, string>> = {}): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const field of ISSUE_FIELDS) {
    raw[field.key] = field.kind === "quantity" ? "1" : field.kind === "bool" ? "false" : field.kind === "shelfFormat" ? "single" : "";
  }
  return { ...raw, ...overrides };
}
