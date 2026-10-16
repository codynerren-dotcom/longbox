import type { CatalogMatch } from "@/lib/catalog/types";
import type { ParsedBarcode } from "@/lib/barcode";
import { pauseLabel, planGcdAcquire, noteGcdRetry, type GcdRateMode } from "@/lib/catalog/rate-limit";
import { formatResumeTime, retryAfterFromMessage, retryAfterMs } from "@/lib/covers/limiter";
import { recordFetch } from "@/lib/log/api";
import { writeLog } from "@/lib/log/write";
import { GcdNameMiss, GCD_NAME_PAGE_CAP, gcdSeriesNameKey, gcdSeriesNameQueries, gcdSeriesNameSegment } from "@/lib/catalog/gcd-name";
import { catalogBaseCount, catalogIssueCount, distinctIssueLabels } from "@/lib/series-view";
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
  /** From `issue_count` when the payload sends it. Absent on older rows. */
  issueCount?: number | null;
  /** Publisher name when the payload includes one. A URL is kept as `publisherId`. */
  publisher?: string | null;
  publisherId?: string | null;
  /** Country code from the series payload (`us`). */
  country?: string | null;
  /** Language code from the series payload (`en`). */
  language?: string | null;
};

export type GcdIssueRow = {
  id: string;
  seriesId: string | null;
  seriesName: string;
  number: string;
  variant: string | null;
  /** Parent issue id from `variant_of`. Null on the base issue. */
  variantOf?: string | null;
  title: string | null;
  coverDate: string | null;
  coverYear: number | null;
  onSaleYear: number | null;
  onSaleDate: string | null;
  price: string | null;
  pageCount: number | null;
  barcode: string | null;
  /** Digits may include hyphens in the raw GCD field. Compared after stripping them. */
  isbn?: string | null;
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
  /**
   * Scan URL from the issue `cover` field, or null when that field is blank.
   * files1.comics.org blocks automated fetches, so match rows do not render it and backfill leaves `imageUrl` empty.
   */
  coverUrl?: string | null;
};

export type GcdNameSearch = {
  /** Stop paging once a series with this normalized name is already in hand. */
  matchName?: string | null;
};

/** Series and issue payloads are reused for a week. A hit does not spend a GCD request. */
export const GCD_RESPONSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type GcdCachedResponse = {
  body: unknown;
  fetchedAt: string;
};

export type GcdResponseCache = {
  read(key: string): Promise<GcdCachedResponse | null>;
  write(key: string, row: GcdCachedResponse): Promise<void>;
};

export type GcdCatalog = {
  seriesByName: (name: string, options?: GcdNameSearch) => Promise<GcdSeriesRow[]>;
  /** Series detail. Optional so older test catalogs still typecheck. */
  seriesById?: (id: string) => Promise<GcdSeriesRow | null>;
  issue: (id: string) => Promise<GcdIssueRow | null>;
  issuesByBarcode: (code: string) => Promise<GcdIssueRow[]>;
  /** Publisher name. Optional so older test catalogs still typecheck. */
  publisher?: (id: string) => Promise<string | null>;
};

const MIN_GAP_MS = 2_000;
const HOURLY_CAP = 30;
const GCD_HOUR_MS = 60 * 60 * 1000;
const GCD_DEFAULT_TIMEOUT_MS = 8_000;
const GCD_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;
const GCD_BACKOFF_CAP_MS = 10 * 60 * 1000;
let nextGcdAt = 0;
/** Request times inside the sliding hour. A burst does not freeze the whole window. */
let gcdHits: number[] = [];
let gcdRateStrikes = 0;

export class GcdBudgetError extends Error {
  readonly pause: { budget: string; count: number | null; resumeAt: number };

  constructor(message: string, pause?: { budget?: string; count?: number | null; resumeAt?: number }) {
    super(message);
    this.name = "GcdBudgetError";
    this.pause = {
      budget: pause?.budget ?? "GCD hourly",
      count: pause?.count ?? null,
      resumeAt: pause?.resumeAt ?? 0,
    };
  }
}

export function resetGcdBudget(now = Date.now()): void {
  nextGcdAt = now;
  gcdHits = [];
  gcdRateStrikes = 0;
}

/** Test hook. The sliding hour counts these timestamps as requests already made. */
export function seedGcdRequests(times: number[]): void {
  gcdHits = times.slice().sort((a, b) => a - b);
}

/** Fallback wait after a 429 with no Retry-After: 30s, 1m, 2m, 5m, then 10m. */
export function gcdBackoffMs(priorPauses: number): number {
  if (priorPauses >= GCD_BACKOFF_MS.length) return GCD_BACKOFF_CAP_MS;
  return GCD_BACKOFF_MS[Math.max(0, priorPauses)] ?? GCD_BACKOFF_CAP_MS;
}

/**
 * Delay for one HTTP 429. A Retry-After header or an "expected available" body hint
 * is waited out in full. The 30s, 1m, 2m, 5m, 10m ladder is only for a 429 with no hint.
 */
export function gcdRetryDelay(explicitMs: number | null): number {
  if (explicitMs != null) return explicitMs;
  const delay = gcdBackoffMs(gcdRateStrikes);
  gcdRateStrikes += 1;
  return delay;
}

function formatPause(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function gcdRatePauseMessage(delayMs: number, resumeAt: number): string {
  return `GCD rate limit. Pausing for ${formatPause(delayMs)}. Resumes at ${formatResumeTime(resumeAt)}.`;
}

async function pauseForRateLimit(response: Response, now = Date.now()): Promise<never> {
  const body = await response.text().catch(() => "");
  const explicit = retryAfterMs(response.headers, now) ?? retryAfterFromMessage(body);
  const delay = await takeGcdRetry(explicit, now);
  const resumeAt = now + delay;
  await writeLog({
    level: "info",
    source: "gcd",
    message: gcdRatePauseMessage(delay, resumeAt),
    details: { delayMs: delay, resumeAt: new Date(resumeAt).toISOString() },
  });
  const mode = await gcdRateMode();
  throw new GcdBudgetError(pauseLabel("GCD", resumeAt), {
    budget: mode === "authenticated" ? "GCD daily" : "GCD hourly",
    count: gcdHits.length,
    resumeAt,
  });
}

/** Retry-After is waited out in full. A missing hint uses the 30s, 1m, 2m, 5m, 10m ladder. */
async function takeGcdRetry(explicitMs: number | null, now: number): Promise<number> {
  if (process.env.VITEST === "true") return gcdRetryDelay(explicitMs);
  const { ensureRateHydrated, readGcdWindow, saveGcdWindow } = await import("@/lib/catalog/rate-store");
  await ensureRateHydrated();
  const state = readGcdWindow();
  const delay = explicitMs != null ? explicitMs : gcdBackoffMs(state.strikes);
  const strikes = explicitMs != null ? state.strikes : state.strikes + 1;
  await saveGcdWindow({ ...noteGcdRetry(state, delay, now), strikes });
  return delay;
}

/**
 * Reserve one request in the sliding hour. Returns the capped resume time when the hour is full.
 * The wait is when the oldest request ages out, and never longer than 10 minutes.
 */
export function gcdHourlyHold(now: number): number | null {
  gcdHits = gcdHits.filter((time) => now - time < GCD_HOUR_MS);
  if (gcdHits.length < HOURLY_CAP) {
    gcdHits.push(now);
    return null;
  }
  const oldest = gcdHits[0] ?? now;
  return Math.min(oldest + GCD_HOUR_MS, now + GCD_BACKOFF_CAP_MS);
}

async function gcdPause(now = Date.now()): Promise<void> {
  if (process.env.VITEST === "true") {
    const resumeAt = gcdHourlyHold(now);
    if (resumeAt != null) {
      throw new GcdBudgetError(pauseLabel("GCD", resumeAt), {
        budget: "GCD hourly",
        count: gcdHits.length,
        resumeAt,
      });
    }
    const wait = Math.max(0, nextGcdAt - now);
    nextGcdAt = Math.max(nextGcdAt, now) + MIN_GAP_MS;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return;
  }
  const { ensureRateHydrated, readGcdWindow, saveGcdWindow } = await import("@/lib/catalog/rate-store");
  await ensureRateHydrated();
  const mode = await gcdRateMode();
  const plan = planGcdAcquire(readGcdWindow(), now, mode);
  if (plan.kind === "pause") {
    await saveGcdWindow(plan.state);
    throw new GcdBudgetError(pauseLabel("GCD", plan.hold.resumeAt), {
      budget: plan.hold.budget,
      count: plan.hold.count,
      resumeAt: plan.hold.resumeAt,
    });
  }
  await saveGcdWindow(plan.state);
  if (plan.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, plan.waitMs));
}

/** One outbound GCD request. Match, backfill, and the Settings probe all call this. */
export async function reserveGcdRequest(now = Date.now()): Promise<void> {
  await gcdPause(now);
}

/** Store a Retry-After so the next GCD call, including after a restart, waits it out. */
export async function rememberGcdPause(resumeAt: number, now = Date.now()): Promise<void> {
  const delay = Math.max(0, resumeAt - now);
  await takeGcdRetry(delay > 0 ? delay : 0, now);
}

async function gcdRateMode(): Promise<GcdRateMode> {
  const creds = await gcdCredentials();
  return creds ? "authenticated" : "anonymous";
}

/** True when a saved username and password will be sent as Basic auth. */
export async function gcdAccountSignedIn(): Promise<boolean> {
  return (await gcdCredentials()) != null;
}

async function gcdCredentials(): Promise<{ username: string; password: string } | null> {
  if (process.env.VITEST === "true") {
    const username = process.env.GCD_USERNAME?.trim() ?? "";
    const password = process.env.GCD_PASSWORD?.trim() ?? "";
    if (!username || !password) return null;
    return { username, password };
  }
  const { getSettings } = await import("@/lib/settings/service");
  const settings = await getSettings();
  if (!settings.gcd.username || !settings.gcd.password) return null;
  return { username: settings.gcd.username, password: settings.gcd.password };
}

async function gcdAuthHeader(): Promise<string | null> {
  const creds = await gcdCredentials();
  if (!creds) return null;
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
}

async function withGcdAuth(headers: Record<string, string>): Promise<Record<string, string>> {
  const authorization = await gcdAuthHeader();
  if (!authorization) return headers;
  return { ...headers, Authorization: authorization };
}

async function clearGcdStrikes(): Promise<void> {
  if (process.env.VITEST === "true") {
    gcdRateStrikes = 0;
    return;
  }
  const { readGcdWindow, saveGcdWindow } = await import("@/lib/catalog/rate-store");
  const state = readGcdWindow();
  if (state.strikes === 0 && state.pausedUntil == null) return;
  await saveGcdWindow({ ...state, strikes: 0, pausedUntil: null });
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
  const match = raw.match(/\/(\d+)\/?(?:\?.*)?$/);
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
  const publisher = publisherOf(row.publisher);
  return {
    id,
    name: name.replace(/\s*\((?:18|19|20)\d{2}\s+series\)\s*$/i, "").trim(),
    yearBegan: yearFrom(row.year_began),
    yearEnded: yearFrom(row.year_ended),
    format: text(row.publishing_format),
    issues,
    issueCount: catalogIssueCount(row.issue_count),
    publisher: publisher.name,
    publisherId: publisher.id,
    country: text(row.country),
    language: text(row.language),
  };
}

function publisherOf(value: unknown): { name: string | null; id: string | null } {
  const record = asRecord(value);
  if (record) {
    return {
      name: text(record.name) ?? text(record.publisher_name),
      id: idFromApiUrl(record.api_url) ?? idFromApiUrl(record.url),
    };
  }
  const raw = text(value);
  if (!raw) return { name: null, id: null };
  if (/^https?:\/\//i.test(raw)) return { name: null, id: idFromApiUrl(raw) };
  return { name: raw, id: null };
}

/** Issue descriptors when the series lists them, otherwise `issue_count` as `1..N`. Variant rows collapse to the base number. */
export function parseGcdSeriesRun(value: unknown): { numbers: string[]; issueCount: number | null } | null {
  const row = seriesRecord(value);
  if (!row) return null;
  const descriptors = Array.isArray(row.issue_descriptors) ? row.issue_descriptors.map((item) => text(item)).filter((item): item is string => item != null) : [];
  const numbers = distinctIssueLabels(descriptors);
  const issueCount = catalogBaseCount(descriptors, catalogIssueCount(row.issue_count));
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
  if (body == null) return null;
  return parseGcdSeriesRun(body);
}

/** The issue `cover` field is a scan URL or "". Anything that is not https is dropped. */
export function gcdCoverScan(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
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
    variantOf: variantParentId(row.variant_of),
    title: text(story?.title) ?? text(row.title),
    coverDate: text(row.publication_date),
    coverYear: yearFrom(row.key_date) ?? yearFrom(row.publication_date),
    onSaleYear: yearFrom(onSale),
    onSaleDate: onSale,
    price: text(row.price),
    pageCount: pageCount(row.page_count),
    barcode: text(row.barcode),
    isbn: text(row.isbn),
    publisher: text(row.indicia_publisher),
    writer: creditText(story?.script),
    artist: creditText(story?.pencils),
    coverArtist: creditText(cover?.pencils),
    characters: creditText(story?.characters),
    seriesYear,
    comicvineIssueId: foreignDigits(row, ["cv_id", "comicvine_id", "comicvine_issue_id"]),
    metronIssueId: foreignDigits(row, ["metron_id", "metron_issue_id"]),
    collects: readCollectedIssues(row),
    coverUrl: gcdCoverScan(row.cover),
  };
}

/**
 * `variant_of` on the live issue payload is the parent issue URL, or null on the base issue.
 * A bare id is accepted too.
 */
function variantParentId(value: unknown): string | null {
  const fromUrl = idFromApiUrl(value);
  if (fromUrl) return fromUrl;
  const raw = text(value);
  if (raw && /^\d{1,12}$/.test(raw) && raw !== "0") return raw;
  return null;
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

async function gcdGet(pathAndQuery: string, timeoutMs = GCD_DEFAULT_TIMEOUT_MS): Promise<unknown> {
  await gcdPause();
  const url = `${gcdBase()}${pathAndQuery}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: await withGcdAuth({
        Accept: "application/json",
        "User-Agent": "longbox/1.0 (personal comic shelf)",
      }),
      signal: AbortSignal.timeout(timeoutMs),
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
  if (response.status === 429) await pauseForRateLimit(response);
  await clearGcdStrikes();
  const missed = await missGcdStatus(response, pathAndQuery, url);
  if (missed === "empty") return null;
  if (!response.ok) throw new Error(`GCD returned ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("javascript")) {
    throw new Error("GCD response was not JSON");
  }
  return response.json();
}

/**
 * comics.org has no barcode or ISBN lookup. `/api/v2/issues/?barcode=`,
 * `/api/issues/?barcode=`, `/api/issue/?barcode=`, and `?isbn=` all 404.
 * Callers find the series by name and compare the barcode on each issue.
 */
export async function gcdByBarcode(_parsed: ParsedBarcode): Promise<CatalogMatch[]> {
  return [];
}

export function createGcdCatalog(fetchImpl: typeof fetch = fetch): GcdCatalog {
  return {
    async seriesByName(name, options) {
      return readGcdNamePages(fetchImpl, name, options?.matchName);
    },
    async seriesById(id) {
      if (!/^\d{1,12}$/.test(id) || id === "0") return null;
      const body = await gcdFetch(fetchImpl, `/api/series/${id}/`);
      if (body == null) return null;
      return parseGcdSeries(body);
    },
    async issue(id) {
      if (!/^\d{1,12}$/.test(id)) return null;
      const body = await gcdFetch(fetchImpl, `/api/issue/${id}/`);
      if (body == null) return null;
      return parseGcdIssue(body);
    },
    async issuesByBarcode() {
      return [];
    },
    async publisher(id) {
      if (!/^\d{1,12}$/.test(id) || id === "0") return null;
      const body = await gcdFetch(fetchImpl, `/api/publisher/${id}/`);
      if (body == null) return null;
      return text(asRecord(body)?.name);
    },
  };
}

/**
 * A slash in the name is not put in the path. The rarest long part is queried,
 * then the same title with the slash removed. Paging stops once `matchName`
 * is already in the results, and the later name queries are skipped.
 * Every live page reserves one GCD request.
 */
async function readGcdNamePages(fetchImpl: typeof fetch, name: string, matchName?: string | null): Promise<GcdSeriesRow[]> {
  const target = gcdSeriesNameKey((matchName ?? "").trim() || name);
  const queries = gcdSeriesNameQueries(name);
  const rows: GcdSeriesRow[] = [];
  const seen = new Set<string>();
  let missed = 0;
  for (const query of queries) {
    const segment = gcdSeriesNameSegment(query);
    if (!segment) continue;
    try {
      const pageRows = await readOneGcdName(fetchImpl, segment, target);
      for (const row of pageRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    } catch (error) {
      if (error instanceof GcdNameMiss) {
        missed += 1;
        continue;
      }
      throw error;
    }
    if (target && rows.some((row) => gcdSeriesNameKey(row.name) === target)) break;
  }
  if (rows.length === 0 && missed > 0 && missed === queries.length) throw new GcdNameMiss(name.trim());
  return rows;
}

async function readOneGcdName(fetchImpl: typeof fetch, segment: string, target: string): Promise<GcdSeriesRow[]> {
  const rows: GcdSeriesRow[] = [];
  const seen = new Set<string>();
  const seenPaths = new Set<string>();
  let path: string | null = `/api/series/name/${segment}/`;
  for (let page = 0; page < GCD_NAME_PAGE_CAP && path; page += 1) {
    if (seenPaths.has(path)) break;
    seenPaths.add(path);
    let body: unknown;
    try {
      body = await gcdFetch(fetchImpl, path);
    } catch (error) {
      if (error instanceof GcdNameMiss) {
        if (page === 0) throw error;
        break;
      }
      throw error;
    }
    if (body == null) break;
    for (const row of asArray(body).map(parseGcdSeries)) {
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (target && rows.some((row) => gcdSeriesNameKey(row.name) === target)) break;
    path = nextGcdNamePage(body);
  }
  return rows;
}

function nextGcdNamePage(body: unknown): string | null {
  const next = text(asRecord(body)?.next);
  if (!next) return null;
  try {
    const url = new URL(next, `${gcdBase()}/`);
    const base = new URL(gcdBase());
    if (url.host !== base.host) return null;
    if (!url.pathname.startsWith("/api/series/name/")) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function gcdFetch(fetchImpl: typeof fetch, pathAndQuery: string, timeoutMs = GCD_DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const cacheKey = gcdResponseCacheKey(pathAndQuery);
  if (cacheKey) {
    const cached = await readFreshGcdResponse(cacheKey);
    if (cached.hit) return cached.body;
  }
  await gcdPause();
  const url = `${gcdBase()}${pathAndQuery}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: await withGcdAuth({
        Accept: "application/json",
        "User-Agent": "longbox/1.0 (personal comic shelf; CC BY-SA)",
      }),
      signal: AbortSignal.timeout(timeoutMs),
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
  if (response.status === 429) await pauseForRateLimit(response);
  await clearGcdStrikes();
  const missed = await missGcdStatus(response, pathAndQuery, url);
  if (missed === "empty") return null;
  if (!response.ok) throw new Error(`GCD returned ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("javascript")) throw new Error("GCD response was not JSON");
  const body: unknown = await response.json();
  if (cacheKey) await writeGcdResponse(cacheKey, body);
  return body;
}

/** `/api/series/` and `/api/issue/` payloads, including a name-search page. Publisher lookups stay live. */
function gcdResponseCacheKey(pathAndQuery: string): string | null {
  const path = pathAndQuery.split("?")[0] ?? "";
  if (/^\/api\/issue\/\d+\/?$/.test(path)) return `gcd-cache:${pathAndQuery}`;
  if (/^\/api\/series\/\d+\/?$/.test(path)) return `gcd-cache:${pathAndQuery}`;
  if (path.startsWith("/api/series/name/")) return `gcd-cache:${pathAndQuery}`;
  return null;
}

let injectedGcdResponseCache: GcdResponseCache | null | undefined;

/** Tests inject a store. Production uses `AppSetting`. Vitest leaves the cache off unless injected. */
export function setGcdResponseCacheForTests(cache: GcdResponseCache | null): void {
  injectedGcdResponseCache = cache;
}

function activeGcdResponseCache(): GcdResponseCache | null {
  if (injectedGcdResponseCache !== undefined) return injectedGcdResponseCache;
  if (process.env.VITEST === "true") return null;
  return prismaGcdResponseCache;
}

const prismaGcdResponseCache: GcdResponseCache = {
  async read(key) {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.appSetting.findUnique({ where: { key } });
    return parseGcdCachedResponse(row?.plain ?? null);
  },
  async write(key, row) {
    const { prisma } = await import("@/lib/db");
    const plain = JSON.stringify(row);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, secret: null, plain },
      update: { secret: null, plain },
    });
  },
};

function parseGcdCachedResponse(plain: string | null): GcdCachedResponse | null {
  if (!plain) return null;
  try {
    const value = JSON.parse(plain) as { body?: unknown; fetchedAt?: unknown };
    if (!value || typeof value !== "object" || typeof value.fetchedAt !== "string") return null;
    if (!("body" in value)) return null;
    return { body: value.body, fetchedAt: value.fetchedAt };
  } catch {
    return null;
  }
}

async function readFreshGcdResponse(key: string): Promise<{ hit: true; body: unknown } | { hit: false }> {
  const cache = activeGcdResponseCache();
  if (!cache) return { hit: false };
  try {
    const row = await cache.read(key);
    if (!row) return { hit: false };
    const then = Date.parse(row.fetchedAt);
    if (Number.isNaN(then)) return { hit: false };
    const age = Date.now() - then;
    if (age < 0 || age >= GCD_RESPONSE_MAX_AGE_MS) return { hit: false };
    return { hit: true, body: row.body };
  } catch {
    return { hit: false };
  }
}

async function writeGcdResponse(key: string, body: unknown): Promise<void> {
  const cache = activeGcdResponseCache();
  if (!cache) return;
  try {
    await cache.write(key, { body, fetchedAt: new Date().toISOString() });
  } catch {
    return;
  }
}

/** A 404 on `/api/series/name/` is an empty name search. Any other 404 is a missing record. */
async function missGcdStatus(response: Response, pathAndQuery: string, url: string): Promise<"empty" | null> {
  if (response.ok) return null;
  if (response.status !== 404) return null;
  if (!isSeriesNamePath(pathAndQuery)) return "empty";
  const label = seriesNameLabel(pathAndQuery);
  await writeLog({
    level: "info",
    source: "gcd",
    message: `No GCD series named ${label}`,
    details: { url },
  });
  throw new GcdNameMiss(label);
}

function isSeriesNamePath(path: string): boolean {
  return path.startsWith("/api/series/name/");
}

function seriesNameLabel(path: string): string {
  const match = path.match(/\/api\/series\/name\/([^/?]+)/);
  const raw = match?.[1] ?? "";
  if (!raw) return path;
  try {
    const decoded = decodeURIComponent(raw).replace(/\s+/g, " ").trim();
    return decoded || raw;
  } catch {
    return raw;
  }
}

export async function gcdSearch(query: string, issueNo?: string): Promise<CatalogMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  for (const name of gcdSeriesNameQueries(trimmed)) {
    const segment = gcdSeriesNameSegment(name);
    if (!segment) continue;
    try {
      const body = await gcdGet(`/api/series/name/${segment}/`);
      if (body == null) continue;
      const seriesList = asArray(body);
      const first = asRecord(seriesList[0] ?? body);
      const seriesId = text(first?.id);
      if (!seriesId) continue;
      const issueBody = await gcdGet(`/api/series/${seriesId}/issues/`);
      if (issueBody == null) continue;
      return asArray(issueBody)
        .map((item) => toMatch(item, ""))
        .filter((match): match is CatalogMatch => match !== null)
        .filter((match) => (issueNo?.trim() ? match.issueNo === issueNo.trim() : true));
    } catch (error) {
      if (error instanceof GcdNameMiss) continue;
      return [];
    }
  }
  return [];
}
