import { variantCoversFrom } from "@/lib/catalog/match-hits";
import { catalogIssueCount, distinctIssueLabels } from "@/lib/series-view";
import { mapMetronDetails, type MetronDetails } from "@/lib/covers/enrich";
import { fileBudgetStore } from "@/lib/covers/files";
import { budgetDay, retryAfterFromMessage, retryAfterMs, MetronLimiter } from "@/lib/covers/limiter";
import { coverYearOf } from "@/lib/covers/match";
import { MetronBudgetError, type CoverLookup, type MetronIssueHit, type MetronSeriesHit } from "@/lib/covers/types";
import { recordFetch } from "@/lib/log/api";
import { writeLog } from "@/lib/log/write";
import { getSettings } from "@/lib/settings/service";

export type MetronTransport = {
  fetch: typeof fetch;
  limiter: MetronLimiter;
  username: string;
  password: string;
  baseUrl: string;
  now: () => number;
};

type MetronPage = {
  next?: string | null;
  results?: unknown[];
};

export async function metronBasicAuth(): Promise<{ username: string; password: string } | null> {
  const { metron } = await getSettings();
  if (!metron.username || !metron.password) return null;
  return { username: metron.username, password: metron.password };
}

export async function metronBaseUrl(): Promise<string> {
  return (await getSettings()).metron.baseUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let sharedLimiter: MetronLimiter | null = null;

/** One limiter for backfill, enrichment, and Match so they share the same wait. */
export function sharedMetronLimiter(): MetronLimiter {
  if (!sharedLimiter) {
    sharedLimiter = new MetronLimiter(fileBudgetStore(), () => Date.now(), sleep, () => budgetDay(new Date()));
  }
  return sharedLimiter;
}

export async function metronTransport(): Promise<MetronTransport> {
  const auth = await metronBasicAuth();
  if (!auth) throw new Error("Set Metron username and password in Settings or the environment.");
  return {
    fetch,
    limiter: sharedMetronLimiter(),
    username: auth.username,
    password: auth.password,
    baseUrl: await metronBaseUrl(),
    now: () => Date.now(),
  };
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function whole(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
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

export function mapIssue(value: unknown): MetronIssueHit | null {
  const row = record(value);
  if (!row || row.id == null) return null;
  const series = record(row.series);
  const seriesName = text(series?.name) ?? text(series?.series) ?? (typeof row.series === "string" ? text(row.series) : null);
  const variant = text(row.variant) ?? text(record(row.variant)?.name);
  return {
    id: String(row.id),
    seriesId: series?.id != null ? String(series.id) : null,
    seriesName: seriesName ?? "",
    number: text(row.number) ?? "",
    coverYear: coverYearOf(text(row.cover_date)),
    imageUrl: httpsUrl(text(row.image)),
    label: text(row.issue) ?? variant,
    releaseYear: coverYearOf(text(row.store_date)),
    seriesYear: whole(series?.year_began),
    upc: text(row.upc),
    publisher: text(record(series?.publisher)?.name) ?? (typeof series?.publisher === "string" ? text(series.publisher) : null),
    variant,
    cvId: externalDigits(row.cv_id),
    gcdId: externalDigits(row.gcd_id),
    storeDate: isoDay(text(row.store_date)),
    covers: variantCoversFrom(row),
  };
}

function isoDay(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function externalDigits(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !/^\d{1,12}$/.test(raw) || raw === "0") return null;
  return raw;
}

export function mapSeries(value: unknown): MetronSeriesHit | null {
  const row = record(value);
  if (!row || row.id == null) return null;
  const rawName = text(row.name) ?? text(row.series);
  if (!rawName) return null;
  const publisher = record(row.publisher);
  return {
    id: String(row.id),
    name: rawName.replace(/\s+\((?:18|19|20)\d{2}\)\s*$/, "").trim(),
    yearBegan: whole(row.year_began),
    yearEnd: whole(row.year_end),
    publisher: text(publisher?.name) ?? (typeof row.publisher === "string" ? text(row.publisher) : null),
  };
}

async function getJson(transport: MetronTransport, pathOrUrl: string): Promise<MetronPage> {
  let attempt = 0;
  while (true) {
    await transport.limiter.acquire();
    const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://") ? pathOrUrl : `${transport.baseUrl}${pathOrUrl}`;
    const started = transport.now();
    let response: Response;
    try {
      response = await transport.fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: basicAuthHeader(transport.username, transport.password),
          "User-Agent": "longbox/1.0",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      await recordFetch({
        source: "metron",
        url,
        startedAt: started,
        status: null,
        error: error instanceof Error ? error.message : "Request failed.",
        now: transport.now(),
      });
      throw error;
    }
    await recordFetch({ source: "metron", url, startedAt: started, status: response.status, now: transport.now() });
    if (response.status === 429) {
      attempt += 1;
      transport.limiter.observe(response.headers);
      const body = await response.text().catch(() => "");
      const delay = retryAfterMs(response.headers, transport.now()) ?? retryAfterFromMessage(body) ?? Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      if (attempt >= 3 || delay > 120_000) {
        throw new MetronBudgetError("Metron rate limit reached. Stopping so the run can resume.");
      }
      await writeLog({
        level: "warn",
        source: "covers/backfill",
        message: `Metron rate limit, backing off ${delay}ms.`,
        details: { delayMs: delay, attempt, status: 429 },
      });
      transport.limiter.defer(delay);
      continue;
    }
    if (!response.ok) throw new Error(`Metron returned ${response.status}`);
    transport.limiter.observe(response.headers);
    return (await response.json()) as MetronPage;
  }
}

async function collect(transport: MetronTransport, path: string, map: (value: unknown) => MetronIssueHit | MetronSeriesHit | null) {
  const hits: Array<MetronIssueHit | MetronSeriesHit> = [];
  let next: string | null = path;
  for (let page = 0; page < 5 && next; page += 1) {
    const body = await getJson(transport, next);
    for (const row of body.results ?? []) {
      const hit = map(row);
      if (hit) hits.push(hit);
    }
    next = typeof body.next === "string" && body.next ? body.next : null;
  }
  return hits;
}

export function createMetronCoverLookup(transport: MetronTransport): CoverLookup {
  return {
    async issuesByUpc(upc) {
      const hits = await collect(transport, `/issue/?upc=${encodeURIComponent(upc)}`, mapIssue);
      return hits as MetronIssueHit[];
    },
    async issuesByUpcPrefix(upc) {
      const hits = await collect(transport, `/issue/?upc_starts_with=${encodeURIComponent(upc)}`, mapIssue);
      return hits as MetronIssueHit[];
    },
    async searchSeries(name) {
      const params = new URLSearchParams({ name });
      const hits = await collect(transport, `/series/?${params.toString()}`, mapSeries);
      return hits as MetronSeriesHit[];
    },
    async issuesForSeries(seriesId, number, coverYear) {
      const params = new URLSearchParams({ series_id: seriesId, number });
      if (coverYear != null) params.set("cover_year", String(coverYear));
      const hits = await collect(transport, `/issue/?${params.toString()}`, mapIssue);
      return hits as MetronIssueHit[];
    },
  };
}

/** Metron filters an issue list by Comic Vine id (`cv_id`) or GCD id (`gcd_id`). */
export async function metronIssuesByCrossId(transport: MetronTransport, key: "cv_id" | "gcd_id", id: string): Promise<MetronIssueHit[]> {
  const digits = externalDigits(id);
  if (!digits) return [];
  const hits = await collect(transport, `/issue/?${key}=${encodeURIComponent(digits)}`, mapIssue);
  return hits as MetronIssueHit[];
}

export async function listMetronIssueRows(transport: MetronTransport, path: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let next: string | null = path;
  for (let page = 0; page < 3 && next; page += 1) {
    const body = await getJson(transport, next);
    rows.push(...(body.results ?? []));
    next = typeof body.next === "string" && body.next ? body.next : null;
    if (rows.length >= 12) break;
  }
  return rows.slice(0, 12);
}

export async function fetchMetronIssueBody(transport: MetronTransport, metronIssueId: string): Promise<unknown | null> {
  if (!/^\d+$/.test(metronIssueId)) return null;
  const body = await getJson(transport, `/issue/${metronIssueId}/`);
  return (body as { results?: unknown }).results ?? body;
}

export async function fetchMetronIssueRecord(transport: MetronTransport, metronIssueId: string): Promise<MetronDetails | null> {
  const row = await fetchMetronIssueBody(transport, metronIssueId);
  return row ? mapMetronDetails(row) : null;
}

const SERIES_RUN_PAGES = 15;

export function readMetronIssueCount(body: unknown): number | null {
  const row = record(body);
  if (!row) return null;
  const direct = catalogIssueCount(row.issue_count);
  if (direct != null) return direct;
  const nested = record(row.results);
  return nested ? catalogIssueCount(nested.issue_count) : null;
}

export function readMetronIssueNumber(value: unknown): string | null {
  const row = record(value);
  return row ? text(row.number) : null;
}

/**
 * Prefer a finished issue list. A truncated list with a larger `issue_count`
 * falls back to that count, because variant rows inflate the count.
 */
export function selectMetronSeriesRun(args: {
  numbers: string[];
  issueCount: number | null;
  complete: boolean;
}): { numbers: string[]; issueCount: number | null } | null {
  const numbers = distinctIssueLabels(args.numbers);
  const issueCount = catalogIssueCount(args.issueCount);
  if (args.complete && numbers.length > 0) return { numbers, issueCount };
  if (!args.complete && issueCount != null && issueCount > numbers.length) return { numbers: [], issueCount };
  if (numbers.length > 0) return { numbers, issueCount };
  if (issueCount != null) return { numbers: [], issueCount };
  return null;
}

/** Series `issue_count` plus distinct issue numbers from `/issue/?series_id=`. */
export async function fetchMetronSeriesRun(
  transport: MetronTransport,
  seriesId: string,
): Promise<{ numbers: string[]; issueCount: number | null } | null> {
  if (!/^\d+$/.test(seriesId) || seriesId === "0") return null;
  const seriesBody = await getJson(transport, `/series/${seriesId}/`);
  const issueCount = readMetronIssueCount(seriesBody);
  const numbers: string[] = [];
  let complete = true;
  let next: string | null = `/issue/?series_id=${encodeURIComponent(seriesId)}`;
  for (let page = 0; page < SERIES_RUN_PAGES && next; page += 1) {
    const body = await getJson(transport, next);
    for (const row of body.results ?? []) {
      const number = readMetronIssueNumber(row);
      if (number) numbers.push(number);
    }
    next = typeof body.next === "string" && body.next ? body.next : null;
    if (next && page === SERIES_RUN_PAGES - 1) {
      complete = false;
      next = null;
    }
  }
  return selectMetronSeriesRun({ numbers, issueCount, complete });
}

export async function fetchMetronIssue(transport: MetronTransport, metronIssueId: string): Promise<MetronIssueHit | null> {
  const detail = await fetchMetronIssueRecord(transport, metronIssueId);
  if (!detail) return null;
  return {
    id: detail.id,
    seriesId: detail.seriesId,
    seriesName: detail.seriesName,
    number: detail.number,
    coverYear: detail.coverYear,
    imageUrl: detail.imageUrl,
    label: detail.title,
  };
}
