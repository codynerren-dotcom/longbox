import type { CatalogMatch } from "@/lib/catalog/types";
import type { ParsedBarcode } from "@/lib/barcode";
import { pauseLabel, planGcdAcquire, noteGcdRetry, type GcdRateMode } from "@/lib/catalog/rate-limit";
import { formatResumeTime, retryAfterFromMessage, retryAfterMs } from "@/lib/covers/limiter";
import { recordFetch } from "@/lib/log/api";
import { writeLog } from "@/lib/log/write";
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
  /** From `issue_count` when the payload sends it. Absent on older rows. */
  issueCount?: number | null;
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
};

export type GcdCatalog = {
  seriesByName: (name: string) => Promise<GcdSeriesRow[]>;
  /** Series detail. Optional so older test catalogs still typecheck. */
  seriesById?: (id: string) => Promise<GcdSeriesRow | null>;
  issue: (id: string) => Promise<GcdIssueRow | null>;
  issuesByBarcode: (code: string) => Promise<GcdIssueRow[]>;
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
  throw new GcdBudgetError(pauseLabel("GCD", resumeAt), {
    budget: "GCD rate limit",
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
  return {
    id,
    name: name.replace(/\s*\((?:18|19|20)\d{2}\s+series\)\s*$/i, "").trim(),
    yearBegan: yearFrom(row.year_began),
    yearEnded: yearFrom(row.year_ended),
    format: text(row.publishing_format),
    issues,
    issueCount: catalogIssueCount(row.issue_count),
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
    async seriesByName(name) {
      const body = await gcdFetch(fetchImpl, `/api/series/name/${encodeURIComponent(name.trim())}/`);
      return asArray(body).map(parseGcdSeries).filter((row): row is GcdSeriesRow => row !== null);
    },
    async seriesById(id) {
      if (!/^\d{1,12}$/.test(id) || id === "0") return null;
      const body = await gcdFetch(fetchImpl, `/api/series/${id}/`);
      return parseGcdSeries(body);
    },
    async issue(id) {
      if (!/^\d{1,12}$/.test(id)) return null;
      const body = await gcdFetch(fetchImpl, `/api/issue/${id}/`);
      return parseGcdIssue(body);
    },
    async issuesByBarcode() {
      return [];
    },
  };
}

async function gcdFetch(fetchImpl: typeof fetch, pathAndQuery: string, timeoutMs = GCD_DEFAULT_TIMEOUT_MS): Promise<unknown> {
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
