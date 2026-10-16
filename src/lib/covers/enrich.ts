import { metronSiteUrl } from "@/lib/catalog-links";
import { variantCoversFrom } from "@/lib/catalog/match-hits";
import { coverYearOf } from "@/lib/covers/match";
import { readCollectedIssues } from "@/lib/shelf-format";

export const METRON_FIELDS = [
  "coverDate",
  "coverYear",
  "releaseDate",
  "title",
  "storyArc",
  "plot",
  "pageCount",
  "coverPrice",
  "barcode",
  "writer",
  "artist",
  "coverArtist",
  "characters",
  "teams",
  "imprint",
  "seriesYear",
  "seriesVolume",
  "metronIssueId",
  "metronSeriesId",
  "metronIssueUrl",
  "metronSeriesUrl",
  "comicvineIssueId",
  "comicvineSeriesId",
] as const;

export type MetronField = (typeof METRON_FIELDS)[number];

export const CLZ_ENRICH_FIELDS = [
  "coverDate",
  "releaseDate",
  "title",
  "storyArc",
  "plot",
  "pageCount",
  "coverPrice",
  "barcode",
  "imprint",
  "coverYear",
] as const satisfies readonly MetronField[];

const ZERO_BLANK = new Set<MetronField>(["pageCount", "coverPrice", "coverYear", "seriesYear", "seriesVolume"]);
const WRITER_ROLES = new Set(["writer", "script", "story"]);
const ARTIST_ROLES = new Set(["artist", "penciller", "penciler", "interior", "interior artist"]);
const COVER_ROLES = new Set(["cover", "cover artist", "covers", "cover penciller", "cover penciler"]);
const TEXT_CAP = 8000;

export type MetronDetails = {
  id: string;
  seriesId: string | null;
  seriesName: string;
  number: string;
  imageUrl: string | null;
  coverDate: string | null;
  coverYear: number | null;
  releaseDate: Date | null;
  title: string | null;
  storyArc: string | null;
  plot: string | null;
  pageCount: number | null;
  coverPrice: string | null;
  barcode: string | null;
  writer: string | null;
  artist: string | null;
  coverArtist: string | null;
  characters: string | null;
  teams: string | null;
  imprint: string | null;
  seriesYear: number | null;
  seriesVolume: number | null;
  metronIssueUrl: string | null;
  metronSeriesUrl: string | null;
  comicvineIssueId: string | null;
  comicvineSeriesId: string | null;
  /** GCD issue id stored on the Metron issue, when Metron sends one. */
  gcdIssueId: string | null;
  gcdSeriesId: string | null;
  /** Variant covers from the same issue payload. The first entry is often the 1st-print "Cover". */
  covers?: Array<{ label: string; imageUrl: string }>;
  /** Single issues this collected edition reprints, when the catalog listed them. */
  collects?: string | null;
};

export type FieldMark = "metron" | "gcd" | "user";
export type FieldSources = Partial<Record<string, FieldMark>>;

export type EnrichmentPlan = {
  patch: Partial<Record<MetronField, string | number | Date>>;
  sources: FieldSources;
  filled: MetronField[];
};

export function isBlank(field: MetronField, value: unknown): boolean {
  if (value == null) return true;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return true;
    return value === 0 && ZERO_BLANK.has(field);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return true;
    return ZERO_BLANK.has(field) && Number(trimmed) === 0;
  }
  if (typeof value === "object") {
    const text = String(value).trim();
    if (!text || text === "[object Object]") return true;
    return ZERO_BLANK.has(field) && Number(text) === 0;
  }
  return true;
}

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

export function readFieldSources(value: unknown): FieldSources {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sources: FieldSources = {};
  for (const [key, source] of Object.entries(value)) {
    if (!FIELD_KEY.test(key)) continue;
    if (source === "user") sources[key] = "user";
    else if ((source === "metron" || source === "gcd") && (METRON_FIELDS as readonly string[]).includes(key)) sources[key] = source;
    else if (source === "gcd" && (key === "variantDescription" || key === "publisher")) sources[key] = source;
  }
  return sources;
}

export function fromMetron(sources: unknown, field: string): boolean {
  return readFieldSources(sources)[field as MetronField] === "metron";
}

export function citesMetron(sources: unknown): boolean {
  return Object.values(readFieldSources(sources)).includes("metron");
}

export function fieldCredit(sources: unknown, field: string): string | null {
  const mark = readFieldSources(sources)[field as MetronField];
  if (mark === "gcd") return "Data from GCD";
  if (mark === "metron") return "from Metron";
  return null;
}

export function mapMetronDetails(value: unknown): MetronDetails | null {
  const row = record(value);
  if (!row || row.id == null) return null;
  const series = record(row.series);
  const seriesName = text(series?.name) ?? text(series?.series) ?? "";
  const coverDate = text(row.cover_date);
  const credits = creditNames(row.credits);
  return {
    id: String(row.id),
    seriesId: series?.id != null ? String(series.id) : null,
    seriesName,
    number: text(row.number) ?? "",
    imageUrl: httpsUrl(text(row.image)),
    coverDate,
    coverYear: coverYearOf(coverDate),
    releaseDate: storeDate(row.store_date),
    title: storyTitle(row, seriesName),
    storyArc: clip(names(row.arcs)),
    plot: clip(text(row.desc)),
    pageCount: positiveInt(row.page ?? row.page_count),
    coverPrice: price(row.price),
    barcode: text(row.upc),
    writer: clip(credits.writer),
    artist: clip(credits.artist),
    coverArtist: clip(credits.coverArtist),
    characters: clip(names(row.characters)),
    teams: clip(names(row.teams)),
    imprint: text(record(row.imprint)?.name) ?? text(row.imprint) ?? text(record(series?.imprint)?.name),
    seriesYear: positiveInt(series?.year_began),
    seriesVolume: positiveInt(series?.volume),
    metronIssueUrl: metronPage(row, "issue"),
    metronSeriesUrl: series ? metronPage(series, "series") : null,
    comicvineIssueId: externalId(row.cv_id),
    comicvineSeriesId: externalId(series?.cv_id ?? row.series_cv_id),
    gcdIssueId: externalId(row.gcd_id),
    gcdSeriesId: externalId(series?.gcd_id ?? row.series_gcd_id),
    covers: variantCoversFrom(row),
    collects: readCollectedIssues(row),
  };
}

const GCD_SKIP = new Set<MetronField>([
  "metronIssueId",
  "metronSeriesId",
  "metronIssueUrl",
  "metronSeriesUrl",
  "comicvineIssueId",
  "comicvineSeriesId",
]);

export function planEnrichment(
  current: Partial<Record<MetronField, unknown>>,
  detail: MetronDetails,
  fieldSources: unknown,
  origin: "metron" | "gcd" = "metron",
  options?: { overwrite?: boolean },
): EnrichmentPlan {
  const incoming = valuesFromDetail(detail);
  const sources = readFieldSources(fieldSources);
  const patch: EnrichmentPlan["patch"] = {};
  const filled: MetronField[] = [];
  const overwrite = options?.overwrite === true;
  for (const field of METRON_FIELDS) {
    if (origin === "gcd" && GCD_SKIP.has(field)) continue;
    if (sources[field] === "user") continue;
    const next = incoming[field];
    if (next == null || isBlank(field, next)) continue;
    if (!isBlank(field, current[field])) {
      if (!overwrite || sameStoredValue(current[field], next)) continue;
    }
    patch[field] = next;
    sources[field] = origin;
    filled.push(field);
  }
  return { patch, sources, filled };
}

function sameStoredValue(current: unknown, next: string | number | Date): boolean {
  if (next instanceof Date) {
    const time = current instanceof Date ? current.getTime() : new Date(String(current)).getTime();
    return time === next.getTime();
  }
  if (typeof next === "number") return Number(current) === next;
  return String(current ?? "").trim() === String(next).trim();
}

export function protectMetronFields<T extends Record<string, unknown>>(
  update: T,
  fieldSources: unknown,
): { update: T; sources: FieldSources; changedSources: boolean } {
  const sources = readFieldSources(fieldSources);
  const next = { ...update };
  let changedSources = false;
  for (const field of CLZ_ENRICH_FIELDS) {
    if (sources[field] === "user") {
      delete next[field];
      continue;
    }
    if (isBlank(field, next[field])) {
      delete next[field];
      continue;
    }
    if (sources[field] === "metron" || sources[field] === "gcd") {
      delete sources[field];
      changedSources = true;
    }
  }
  return { update: next, sources, changedSources };
}

function valuesFromDetail(detail: MetronDetails): Partial<Record<MetronField, string | number | Date>> {
  return {
    coverDate: detail.coverDate ?? undefined,
    coverYear: detail.coverYear ?? undefined,
    releaseDate: detail.releaseDate ?? undefined,
    title: detail.title ?? undefined,
    storyArc: detail.storyArc ?? undefined,
    plot: detail.plot ?? undefined,
    pageCount: detail.pageCount ?? undefined,
    coverPrice: detail.coverPrice ?? undefined,
    barcode: detail.barcode ?? undefined,
    writer: detail.writer ?? undefined,
    artist: detail.artist ?? undefined,
    coverArtist: detail.coverArtist ?? undefined,
    characters: detail.characters ?? undefined,
    teams: detail.teams ?? undefined,
    imprint: detail.imprint ?? undefined,
    seriesYear: detail.seriesYear ?? undefined,
    seriesVolume: detail.seriesVolume ?? undefined,
    metronIssueId: detail.id,
    metronSeriesId: detail.seriesId ?? undefined,
    metronIssueUrl: detail.metronIssueUrl ?? undefined,
    metronSeriesUrl: detail.metronSeriesUrl ?? undefined,
    comicvineIssueId: detail.comicvineIssueId ?? undefined,
    comicvineSeriesId: detail.comicvineSeriesId ?? undefined,
  };
}

function metronPage(row: Record<string, unknown>, kind: "issue" | "series"): string | null {
  const linked = metronSiteUrl(row.resource_url, kind) ?? metronSiteUrl(row.site_url, kind) ?? metronSiteUrl(row.url, kind);
  if (linked) return linked;
  const slug = text(row.slug);
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(slug)) return null;
  return `https://metron.cloud/${kind}/${slug}/`;
}

function externalId(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !/^\d{1,12}$/.test(raw) || raw === "0") return null;
  return raw;
}

function storyTitle(row: Record<string, unknown>, seriesName: string): string | null {
  const direct = text(row.title);
  if (direct && !sameName(direct, seriesName)) return clip(direct);
  return clip(names(row.name, seriesName));
}

function creditNames(value: unknown): { writer: string | null; artist: string | null; coverArtist: string | null } {
  const writer: string[] = [];
  const artist: string[] = [];
  const coverArtist: string[] = [];
  if (!Array.isArray(value)) return { writer: null, artist: null, coverArtist: null };
  for (const item of value) {
    const row = record(item);
    if (!row) continue;
    const creator = text(row.creator) ?? text(record(row.creator)?.name);
    if (!creator) continue;
    for (const role of roleNames(row.role ?? row.roles)) {
      if (WRITER_ROLES.has(role)) pushUnique(writer, creator);
      if (ARTIST_ROLES.has(role)) pushUnique(artist, creator);
      if (COVER_ROLES.has(role)) pushUnique(coverArtist, creator);
    }
  }
  return {
    writer: writer.length ? writer.join(", ") : null,
    artist: artist.length ? artist.join(", ") : null,
    coverArtist: coverArtist.length ? coverArtist.join(", ") : null,
  };
}

function roleNames(value: unknown): string[] {
  if (typeof value === "string") return [normalizeRole(value)].filter(Boolean);
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const name = typeof item === "string" ? item : text(record(item)?.name);
    const role = name ? normalizeRole(name) : "";
    if (role) names.push(role);
  }
  return names;
}

function normalizeRole(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function names(value: unknown, skip: string | null = null): string | null {
  if (!Array.isArray(value)) return null;
  const list: string[] = [];
  for (const item of value) {
    const name = typeof item === "string" ? text(item) : text(record(item)?.name);
    if (!name || sameName(name, skip)) continue;
    pushUnique(list, name);
  }
  return list.length ? list.join(", ") : null;
}

function pushUnique(list: string[], value: string) {
  if (list.some((item) => item.toLowerCase() === value.toLowerCase())) return;
  list.push(value);
}

function sameName(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function storeDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const date = new Date(`${raw.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function price(value: unknown): string | null {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,]/g, "")) : Number.NaN;
  if (!Number.isFinite(raw) || raw === 0) return null;
  return raw.toFixed(2);
}

function positiveInt(value: unknown): number | null {
  const parsed = whole(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed;
}

function whole(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function clip(value: string | null): string | null {
  if (!value) return null;
  return value.length > TEXT_CAP ? value.slice(0, TEXT_CAP) : value;
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
