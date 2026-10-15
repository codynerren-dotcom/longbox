import type { CatalogMatch } from "@/lib/catalog/types";
import type { ParsedBarcode } from "@/lib/barcode";
import { recordFetch } from "@/lib/log/api";
import { catalogIssueCount, distinctIssueLabels } from "@/lib/series-view";
import { readCollectedIssues } from "@/lib/shelf-format";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as UnknownRecord;
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["results", "issues", "data", "items"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function nameOf(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return text(record.name) ?? text(record.title) ?? text(record.series_name);
}

function toMatch(value: unknown, barcode: string): CatalogMatch | null {
  const record = asRecord(value);
  if (!record) return null;
  const seriesRecord = asRecord(record.series);
  const series = nameOf(record.series) ?? text(record.series_name);
  if (!series) return null;
  const issueNo = text(record.number) ?? text(record.issue_number) ?? text(record.issue) ?? "";
  const id = text(record.id) ?? text(record.issue_id) ?? `${series}-${issueNo}`;
  const seriesId = text(seriesRecord?.id) ?? text(record.series_id);
  return {
    source: "gcd",
    externalId: id,
    series,
    issueNo,
    title: text(record.title) ?? (issueNo ? `${series} #${issueNo}` : series),
    publisher: nameOf(record.publisher) ?? nameOf(seriesRecord?.publisher) ?? text(record.publisher_name),
    coverUrl: null,
    coverDate: text(record.publication_date) ?? text(record.cover_date),
    barcode: text(record.barcode) ?? barcode,
    plot: text(record.notes) ?? text(record.synopsis),
    variant: text(record.variant_name) ?? text(record.variant),
    coreSeriesId: seriesId ? `gcd-${seriesId}` : null,
    ownedId: null,
  };
}

export type GcdSeriesRow = {
  id: string;
  name: string;
  yearBegan: number | null;
  yearEnded: number | null;
  format: string | null;
  issues: Array<{ id: string; descriptor: string }>;
};

export type GcdIssueRow = {
  id: string;
  seriesId: string | null;
  seriesName: string;
  number: string;
  variant: string | null;
  title: string | null;
  coverDate: string | null;
  coverYear: number | null;
  onSaleYear: number | null;
  onSaleDate: string | null;
  price: string | null;
  pageCount: number | null;
  barcode: string | null;
  publisher: string | null;
  writer: string | null;
  artist: string | null;
  coverArtist: string | null;
  characters: string | null;
  seriesYear: number | null;
  /** Present only when the GCD payload itself names another catalog. */
  comicvineIssueId: string | null;
  metronIssueId: string | null;
  collects?: string | null;
};

export type GcdCatalog = {
  seriesByName: (name: string) => Promise<GcdSeriesRow[]>;
  issue: (id: string) => Promise<GcdIssueRow | null>;
  issuesByBarcode: (code: string) => Promise<GcdIssueRow[]>;
};

const MIN_GAP_MS = 2_000;
const HOURLY_CAP = 30;
let nextGcdAt = 0;
let gcdWindowStarted = 0;
let gcdWindowCount = 0;

export class GcdBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcdBudgetError";
  }
}

export function resetGcdBudget(now = Date.now()): void {
  nextGcdAt = now;
  gcdWindowStarted = now;
  gcdWindowCount = 0;
}

async function gcdPause(now = Date.now()): Promise<void> {
  if (now - gcdWindowStarted >= 60 * 60 * 1000) {
    gcdWindowStarted = now;
    gcdWindowCount = 0;
  }
  if (gcdWindowCount >= HOURLY_CAP) {
    throw new GcdBudgetError("GCD rate limit reached. Later copies will stay unmatched.");
  }
  const wait = Math.max(0, nextGcdAt - now);
  nextGcdAt = Math.max(nextGcdAt, now) + MIN_GAP_MS;
  gcdWindowCount += 1;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

function gcdBase(): string {
  return (process.env.GCD_API_BASE || "https://www.comics.org").replace(/\/$/, "");
}

export function gcdIssueHref(id: string | null | undefined): string | null {
  return gcdDigits(id) ? `https://www.comics.org/issue/${gcdDigits(id)}/` : null;
}

export function gcdSeriesHref(id: string | null | undefined): string | null {
  return gcdDigits(id) ? `https://www.comics.org/series/${gcdDigits(id)}/` : null;
}

export function gcdCoverHref(id: string | null | undefined): string | null {
  return gcdDigits(id) ? `https://www.comics.org/issue/${gcdDigits(id)}/cover/4/` : null;
}

function gcdDigits(id: string | null | undefined): string | null {
  const trimmed = id?.trim() ?? "";
  if (!/^\d{1,12}$/.test(trimmed) || trimmed === "0") return null;
  return trimmed;
}

function idFromApiUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/\/(\d+)\/?$/);
  return match?.[1] && match[1] !== "0" ? match[1] : null;
}

function yearFrom(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/\b(18|19|20)\d{2}\b/);
  if (!match) return null;
  const year = Number.parseInt(match[0], 10);
  return Number.isFinite(year) ? year : null;
}

function creditText(value: unknown): string | null {
  const raw = text(value);
  if (!raw || raw === "None" || raw === "?") return null;
  return raw.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim() || null;
}

export function parseGcdSeries(value: unknown): GcdSeriesRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = idFromApiUrl(row.api_url) ?? text(row.id);
  const name = text(row.name);
  if (!id || !name) return null;
  const urls = Array.isArray(row.active_issues) ? row.active_issues : [];
  const descriptors = Array.isArray(row.issue_descriptors) ? row.issue_descriptors : [];
  const issues = urls
    .map((url, index) => {
      const issueId = idFromApiUrl(url);
      if (!issueId) return null;
      return { id: issueId, descriptor: text(descriptors[index]) ?? "" };
    })
    .filter((issue): issue is { id: string; descriptor: string } => issue !== null);
  return {
    id,
    name: name.replace(/\s*\((?:18|19|20)\d{2}\s+series\)\s*$/i, "").trim(),
    yearBegan: yearFrom(row.year_began),
    yearEnded: yearFrom(row.year_ended),
    format: text(row.publishing_format),
    issues,
  };
}

/** Issue descriptors when the series lists them, otherwise `issue_count` as `1..N`. */
export function parseGcdSeriesRun(value: unknown): { numbers: string[]; issueCount: number | null } | null {
  const row = seriesRecord(value);
  if (!row) return null;
  const descriptors = Array.isArray(row.issue_descriptors) ? row.issue_descriptors.map((item) => text(item)).filter((item): item is string => item != null) : [];
  const issueCount = catalogIssueCount(row.issue_count);
  const numbers = distinctIssueLabels(descriptors);
  if (numbers.length > 0) return { numbers, issueCount };
  if (issueCount != null) return { numbers: [], issueCount };
  return null;
}

function seriesRecord(value: unknown): UnknownRecord | null {
  const row = asRecord(value);
  if (!row) return null;
  if (row.issue_descriptors != null || row.issue_count != null || row.active_issues != null) return row;
  if (Array.isArray(row.results) && row.results.length > 0) return asRecord(row.results[0]);
  return asRecord(row.results) ?? row;
}

export async function fetchGcdSeriesRun(
  seriesId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ numbers: string[]; issueCount: number | null } | null> {
  if (!/^\d{1,12}$/.test(seriesId) || seriesId === "0") return null;
  const body = await gcdFetch(fetchImpl, `/api/series/${seriesId}/`);
  return parseGcdSeriesRun(body);
}

export function parseGcdIssue(value: unknown, seriesYear: number | null = null): GcdIssueRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = idFromApiUrl(row.api_url) ?? text(row.id);
  const seriesName = text(row.series_name);
  if (!id || !seriesName) return null;
  const stories = Array.isArray(row.story_set) ? row.story_set.map(asRecord).filter((story): story is UnknownRecord => story !== null) : [];
  const story = stories.find((item) => text(item.type) === "comic story") ?? stories.find((item) => text(item.type) !== "cover") ?? null;
  const cover = stories.find((item) => text(item.type) === "cover") ?? null;
  const onSale = text(row.on_sale_date);
  return {
    id,
    seriesId: idFromApiUrl(row.series),
    seriesName: seriesName.replace(/\s*\((?:18|19|20)\d{2}\s+series\)\s*$/i, "").trim(),
    number: text(row.number) ?? text(row.descriptor) ?? "",
    variant: text(row.variant_name),
    title: text(story?.title) ?? text(row.title),
    coverDate: text(row.publication_date),
    coverYear: yearFrom(row.key_date) ?? yearFrom(row.publication_date),
    onSaleYear: yearFrom(onSale),
    onSaleDate: onSale,
    price: text(row.price),
    pageCount: pageCount(row.page_count),
    barcode: text(row.barcode),
    publisher: text(row.indicia_publisher),
    writer: creditText(story?.script),
    artist: creditText(story?.pencils),
    coverArtist: creditText(cover?.pencils),
    characters: creditText(story?.characters),
    seriesYear,
    comicvineIssueId: foreignDigits(row, ["cv_id", "comicvine_id", "comicvine_issue_id"]),
    metronIssueId: foreignDigits(row, ["metron_id", "metron_issue_id"]),
    collects: readCollectedIssues(row),
  };
}

function foreignDigits(row: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const raw = text(row[key]);
    if (raw && /^\d{1,12}$/.test(raw) && raw !== "0") return raw;
  }
  return null;
}

function pageCount(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount);
}

function barcodeMatches(issue: GcdIssueRow, code: string): boolean {
  const want = code.replace(/\D/g, "");
  const got = (issue.barcode ?? "").replace(/\D/g, "");
  if (want.length < 11 || got.length < 11) return false;
  return got === want || got.startsWith(want) || want.startsWith(got);
}

async function gcdGet(pathAndQuery: string): Promise<unknown> {
  await gcdPause();
  const url = `${gcdBase()}${pathAndQuery}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "longbox/1.0 (personal comic shelf)",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    await recordFetch({
      source: "system",
      url,
      startedAt: started,
      status: null,
      error: error instanceof Error ? error.message : "Request failed.",
    });
    throw error;
  }
  await recordFetch({ source: "system", url, startedAt: started, status: response.status });
  if (!response.ok) throw new Error(`GCD returned ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("javascript")) {
    throw new Error("GCD response was not JSON");
  }
  return response.json();
}

/** Try the public issue endpoints that accept a barcode filter. Skip quietly on failure. */
export async function gcdByBarcode(parsed: ParsedBarcode): Promise<CatalogMatch[]> {
  const code = encodeURIComponent(parsed.combined);
  const paths = [`/api/v2/issues/?barcode=${code}`, `/api/issues/?barcode=${code}`];
  if (parsed.upc && parsed.upc !== parsed.combined) {
    const upc = encodeURIComponent(parsed.upc);
    paths.push(`/api/v2/issues/?barcode=${upc}`, `/api/issues/?barcode=${upc}`);
  }
  for (const path of paths) {
    try {
      const body = await gcdGet(path);
      const matches = asArray(body)
        .map((item) => toMatch(item, parsed.combined))
        .filter((match): match is CatalogMatch => match !== null);
      if (matches.length > 0) return matches;
    } catch {
      continue;
    }
  }
  return [];
}

export function createGcdCatalog(fetchImpl: typeof fetch = fetch): GcdCatalog {
  return {
    async seriesByName(name) {
      const body = await gcdFetch(fetchImpl, `/api/series/name/${encodeURIComponent(name.trim())}/`);
      return asArray(body).map(parseGcdSeries).filter((row): row is GcdSeriesRow => row !== null);
    },
    async issue(id) {
      if (!/^\d{1,12}$/.test(id)) return null;
      const body = await gcdFetch(fetchImpl, `/api/issue/${id}/`);
      return parseGcdIssue(body);
    },
    async issuesByBarcode(code) {
      const encoded = encodeURIComponent(code.trim());
      const paths = [`/api/issue/?barcode=${encoded}`, `/api/issues/?barcode=${encoded}`, `/api/v2/issues/?barcode=${encoded}`];
      for (const path of paths) {
        try {
          const body = await gcdFetch(fetchImpl, path);
          const issues = asArray(body)
            .map((item) => parseGcdIssue(item))
            .filter((issue): issue is GcdIssueRow => issue !== null)
            .filter((issue) => barcodeMatches(issue, code));
          if (issues.length > 0) return issues.slice(0, 8);
        } catch (error) {
          if (error instanceof GcdBudgetError) throw error;
        }
      }
      return [];
    },
  };
}

async function gcdFetch(fetchImpl: typeof fetch, pathAndQuery: string): Promise<unknown> {
  await gcdPause();
  const url = `${gcdBase()}${pathAndQuery}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "longbox/1.0 (personal comic shelf; CC BY-SA)" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    await recordFetch({
      source: "gcd",
      url,
      startedAt: started,
      status: null,
      error: error instanceof Error ? error.message : "Request failed.",
    });
    throw error;
  }
  await recordFetch({ source: "gcd", url, startedAt: started, status: response.status });
  if (response.status === 429) throw new GcdBudgetError("GCD rate limit reached. Later copies will stay unmatched.");
  if (!response.ok) throw new Error(`GCD returned ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("javascript")) throw new Error("GCD response was not JSON");
  return response.json();
}

export async function gcdSearch(query: string, issueNo?: string): Promise<CatalogMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const seriesPath = `/api/series/name/${encodeURIComponent(trimmed)}/`;
  try {
    const body = await gcdGet(seriesPath);
    const seriesList = asArray(body);
    const first = asRecord(seriesList[0] ?? body);
    const seriesId = text(first?.id);
    if (!seriesId) return [];
    const issueBody = await gcdGet(`/api/series/${seriesId}/issues/`);
    return asArray(issueBody)
      .map((item) => toMatch(item, ""))
      .filter((match): match is CatalogMatch => match !== null)
      .filter((match) => (issueNo?.trim() ? match.issueNo === issueNo.trim() : true));
  } catch {
    return [];
  }
}
