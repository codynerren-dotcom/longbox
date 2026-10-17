import { variantCoversFrom } from "@/lib/catalog/match-hits";
import { fullRunMetronCap, METRON_FALLBACK_DAILY, metronFullRunShare, pauseLabel, planMetronAcquire } from "@/lib/catalog/rate-limit";
import { currentLane } from "@/lib/catalog/rate-lane";
import { readMetronWindow, saveMetronWindow } from "@/lib/catalog/rate-store";
import { catalogBaseCount, catalogIssueCount, distinctIssueLabels, isVariantDescriptor } from "@/lib/series-view";
import { mapMetronDetails, type MetronDetails } from "@/lib/covers/enrich";
import { fileBudgetStore } from "@/lib/covers/files";
import { METRON_USER_AGENT } from "@/lib/covers/metron-headers";
import { budgetDay, formatResumeTime, metronStatusPlan, MetronLimiter, nextBudgetDayStart, type BudgetStore } from "@/lib/covers/limiter";
import { coverYearOf } from "@/lib/covers/match";
import {
  assertMetronCircuit,
  METRON_CIRCUIT_BASE_MS,
  readMetronCircuit,
  recordMetronTransportFailure,
  recordMetronTransportSuccess,
} from "@/lib/covers/metron-circuit";
import { MetronBudgetError, MetronConnectError, type CoverLookup, type MetronIssueHit, type MetronSeriesHit, type MetronSeriesQuery } from "@/lib/covers/types";
import { recordFetch } from "@/lib/log/api";
import { writeLog } from "@/lib/log/write";
import { getSettings } from "@/lib/settings/service";
import { metronAuthorization } from "@/lib/settings/resolve";

export type MetronTransport = {
  fetch: typeof fetch;
  limiter: MetronLimiter;
  username: string;
  password: string;
  /** Set by the live client. Tests that only have a username and password leave this unset. */
  authorization?: string;
  baseUrl: string;
  now: () => number;
};

type MetronPage = {
  next?: string | null;
  results?: unknown[];
};

/** True when a Bearer token or a username and password is configured. The pair may be blank when only a token is set. */
export async function metronBasicAuth(): Promise<{ username: string; password: string } | null> {
  const settings = await getSettings();
  if (!metronAuthorization(settings)) return null;
  return { username: settings.metron.username, password: settings.metron.password };
}

export async function metronBaseUrl(): Promise<string> {
  return (await getSettings()).metron.baseUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Background runs stop after this many Metron requests and resume later. */
export const METRON_JOB_LIMIT = 60;
const METRON_JOB_PAUSE_MS = 60_000;
let jobDepth = 0;
let jobUsed = 0;

/** Count Metron requests for a background run. Nested jobs share one counter. */
export function armMetronJobBudget(): void {
  if (jobDepth === 0) jobUsed = 0;
  jobDepth += 1;
}

export function clearMetronJobBudget(): void {
  jobDepth = Math.max(0, jobDepth - 1);
  if (jobDepth === 0) jobUsed = 0;
}

let fullRunActive = false;
let fullRunUsed = 0;
let fullRunDay = "";

/** A full re-match may spend one share of the sustained day. A job pause keeps the count. */
export function armFullRunCap(input?: { used?: number; day?: string }): void {
  fullRunActive = true;
  fullRunUsed = input?.used != null && input.used > 0 ? Math.round(input.used) : 0;
  fullRunDay = input?.day ?? "";
}

export function clearFullRunCap(): void {
  fullRunActive = false;
  fullRunUsed = 0;
  fullRunDay = "";
}

export function fullRunMetronUsed(): { used: number; day: string } {
  return { used: fullRunUsed, day: fullRunDay };
}

/** Refuse before the request when this full run has used its share of the day. The pause lasts until the sustained reset. */
export function guardFullRunCall(now: number, sustainedLimit: number | null, sustainedResetAt: number | null = null): void {
  if (!fullRunActive) return;
  const day = budgetDay(new Date(now));
  if (fullRunDay !== day) {
    fullRunUsed = 0;
    fullRunDay = day;
  }
  const limit = sustainedLimit != null && sustainedLimit > 0 ? sustainedLimit : METRON_FALLBACK_DAILY;
  const share = metronFullRunShare();
  const cap = fullRunMetronCap(limit, share);
  if (fullRunUsed >= cap) {
    const percent = Math.round(share * 100);
    const resumeAt = sustainedResetAt != null && sustainedResetAt > now ? sustainedResetAt : nextBudgetDayStart(now);
    throw new MetronBudgetError(
      `Full re-match used ${percent}% of today's Metron budget. Pausing so searches still have room.`,
      { budget: "Metron full run", count: fullRunUsed, resumeAt },
    );
  }
}

/** Count a send that acquired a slot. A burst pause never reaches this. */
export function recordFullRunCall(now: number): void {
  if (!fullRunActive) return;
  const day = budgetDay(new Date(now));
  if (fullRunDay !== day) {
    fullRunUsed = 0;
    fullRunDay = day;
  }
  fullRunUsed += 1;
}

let sharedLimiter: MetronLimiter | null = null;

/** The database window is the copy that survives a restart. Tests keep the file store. */
function persistentBudgetStore(): BudgetStore {
  return {
    read: () => readMetronWindow(),
    write: (budget) => {
      void saveMetronWindow(budget);
    },
  };
}

/** One limiter for backfill, enrichment, and Match so they share the same wait. */
export function sharedMetronLimiter(): MetronLimiter {
  if (!sharedLimiter) {
    const pacing = process.env.VITEST === "true" ? async () => undefined : sleep;
    const store = process.env.VITEST === "true" ? fileBudgetStore() : persistentBudgetStore();
    sharedLimiter = new MetronLimiter(store, () => Date.now(), pacing, () => budgetDay(new Date()));
  }
  return sharedLimiter;
}

export async function metronTransport(): Promise<MetronTransport> {
  const settings = await getSettings();
  const auth = metronAuthorization(settings);
  if (!auth) throw new Error("Set a Metron API token, or a username and password, in Settings or the environment.");
  return {
    fetch,
    limiter: sharedMetronLimiter(),
    username: settings.metron.username,
    password: settings.metron.password,
    authorization: auth.header,
    baseUrl: auth.baseUrl,
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
  const covers = coversWithUpc(row);
  const upcs = listedUpcs(row);
  const altNumber = text(row.alt_number);
  const seriesVolume = whole(series?.volume);
  return {
    id: String(row.id),
    seriesId: series?.id != null ? String(series.id) : null,
    seriesName: seriesName ?? "",
    number: issueNumberText(row),
    ...(altNumber ? { altNumber } : {}),
    coverYear: coverYearOf(text(row.cover_date)),
    imageUrl: httpsUrl(text(row.image)),
    label: text(row.issue) ?? variant,
    releaseYear: coverYearOf(text(row.store_date)),
    seriesYear: whole(series?.year_began),
    ...(seriesVolume != null ? { seriesVolume } : {}),
    upc: text(row.upc),
    upcs,
    publisher:
      text(record(series?.publisher)?.name) ??
      (typeof series?.publisher === "string" ? text(series.publisher) : null) ??
      text(record(row.publisher)?.name) ??
      (typeof row.publisher === "string" ? text(row.publisher) : null),
    variant,
    cvId: externalDigits(row.cv_id),
    gcdId: externalDigits(row.gcd_id),
    storeDate: isoDay(text(row.store_date)),
    covers,
  };
}

/** Issue `number`, then a leading number in `alt_number` or the display label. */
function issueNumberText(row: Record<string, unknown>): string {
  const direct = text(row.number);
  if (direct) return direct;
  const alt = text(row.alt_number);
  if (alt && /^\d/.test(alt)) return alt;
  const label = text(row.issue) ?? text(row.name) ?? text(row.title);
  const match = label?.match(/#\s*(\d+[A-Za-z]?)/);
  return match?.[1] ?? "";
}

/**
 * Detail `upc` is a top-level field and also `variants[].upc`. Both are nullable.
 * `sku` is a distributor code, not a barcode, so it stays out of this list.
 */
function listedUpcs(row: Record<string, unknown>): string[] {
  const codes: Array<string | null> = [text(row.upc)];
  for (const list of [row.variants, row.variant_covers, row.alt_covers]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const entry = record(item);
      if (!entry) continue;
      codes.push(text(entry.upc));
    }
  }
  return uniqueCodes(codes);
}

function uniqueCodes(values: Array<string | null | undefined>): string[] {
  const codes: string[] = [];
  for (const value of values) {
    const code = value?.trim();
    if (!code || codes.includes(code)) continue;
    codes.push(code);
  }
  return codes;
}

/** List results omit `upc`. Detail results put the add-on on the issue or on a variant cover. */
function coversWithUpc(row: Record<string, unknown>): Array<{ label: string; imageUrl: string; upc: string | null }> {
  const byImage = new Map<string, string>();
  for (const list of [row.variants, row.variant_covers, row.alt_covers, row.associated_images]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const entry = record(item);
      if (!entry) continue;
      const image = httpsUrl(text(entry.image) ?? text(entry.cover));
      const upc = text(entry.upc);
      if (image && upc) byImage.set(image, upc);
    }
  }
  return variantCoversFrom(row).map((cover) => ({ ...cover, upc: byImage.get(cover.imageUrl) ?? null }));
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
  const seriesType = text(row.series_type) ?? text(record(row.series_type)?.name);
  return {
    id: String(row.id),
    name: rawName.replace(/\s+\((?:18|19|20)\d{2}(?:\s*[-–—]\s*(?:18|19|20)\d{2})?\)\s*$/, "").trim(),
    yearBegan: whole(row.year_began),
    yearEnd: whole(row.year_end),
    volume: whole(row.volume),
    publisher: text(publisher?.name) ?? (typeof row.publisher === "string" ? text(row.publisher) : null),
    issueCount: catalogIssueCount(row.issue_count),
    ...(seriesType ? { seriesType } : {}),
  };
}

async function takeJobSlot(now: number): Promise<void> {
  if (jobDepth === 0) return;
  jobUsed += 1;
  if (jobUsed <= METRON_JOB_LIMIT) return;
  const resumeAt = now + METRON_JOB_PAUSE_MS;
  await writeLog({
    level: "info",
    source: "metron",
    message: `Metron job budget reached after ${METRON_JOB_LIMIT} requests. Yielding. Resumes at ${formatResumeTime(resumeAt)}.`,
    details: { count: METRON_JOB_LIMIT, resumeAt: new Date(resumeAt).toISOString() },
  });
  throw new MetronBudgetError("Metron request budget reached. Yielding so the run can resume.", {
    budget: "Metron job",
    count: METRON_JOB_LIMIT,
    resumeAt,
  });
}

type CachedDetail = { modified: string | null; etag: string | null; body: MetronPage };

const detailCache = new Map<string, CachedDetail>();

/** Drop conditional-request memory. Tests start from an empty cache. */
export function clearMetronDetailCache(): void {
  detailCache.clear();
}

/**
 * URLs that support conditional requests: an issue detail, or a series `issue_list`.
 * A filtered list such as `/issue/?upc=` does not.
 * Send `If-Modified-Since` and, when the last response included one, `If-None-Match`.
 * https://github.com/Metron-Project/metron/blob/master/api/README.md#conditional-requests
 * https://metron-project.github.io/blog/february-2026-update
 */
export function metronConditionalKey(pathOrUrl: string): string | null {
  const path = pathOrUrl.split("?")[0] ?? pathOrUrl;
  if (/\/issue\/\d+\/?$/.test(path)) return pathOrUrl;
  if (/\/series\/\d+\/issue_list\/?$/.test(path)) return pathOrUrl;
  return null;
}

/**
 * When the queue may send the next Metron request.
 * An open breaker or a spent burst/daily window holds it. A pause with no reset waits out the probe interval.
 */
export function nextMetronQueueAt(now: number): number | null {
  const circuit = readMetronCircuit();
  const open = circuit.openUntil > now ? circuit.openUntil : null;
  const plan = planMetronAcquire(readMetronWindow(), now, "interactive", budgetDay(new Date(now)));
  const rate = plan.kind === "pause" ? (plan.hold.resumeAt > now ? plan.hold.resumeAt : now + METRON_CIRCUIT_BASE_MS) : null;
  if (open != null && rate != null) return Math.max(open, rate);
  return open ?? rate;
}

/** Soonest a queued Metron row may run after a connect timeout. Never sooner than the probe interval. */
export function metronConnectHold(now: number): number {
  const open = readMetronCircuit().openUntil;
  return Math.max(open > now ? open : 0, now + METRON_CIRCUIT_BASE_MS);
}

async function logMetronFetch(
  transport: MetronTransport,
  url: string,
  started: number,
  status: number | null,
  error?: string,
): Promise<void> {
  await recordFetch({
    source: "metron",
    url,
    startedAt: started,
    status,
    error,
    now: transport.now(),
    dayCount: transport.limiter.snapshot().count,
  });
}

async function getJson(transport: MetronTransport, pathOrUrl: string): Promise<MetronPage> {
  if (process.env.VITEST !== "true") {
    const { ensureRateHydrated } = await import("@/lib/catalog/rate-store");
    await ensureRateHydrated();
  }
  const lane = currentLane();
  let attempt = 0;
  while (true) {
    attempt += 1;
    assertMetronCircuit(transport.now());
    await takeJobSlot(transport.now());
    const budgetSnap = transport.limiter.snapshot();
    guardFullRunCall(transport.now(), budgetSnap.sustainedLimit, budgetSnap.sustainedResetAt);
    await transport.limiter.acquire(lane);
    recordFullRunCall(transport.now());
    const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://") ? pathOrUrl : `${transport.baseUrl}${pathOrUrl}`;
    const cacheKey = metronConditionalKey(url);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: transport.authorization ?? basicAuthHeader(transport.username, transport.password),
      "User-Agent": METRON_USER_AGENT,
    };
    const cached = cacheKey ? detailCache.get(cacheKey) : undefined;
    if (cached?.modified) headers["If-Modified-Since"] = cached.modified;
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const started = transport.now();
    let response: Response;
    try {
      response = await transport.fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const connect = new MetronConnectError(error instanceof Error ? error.message : "Request failed.", { cause: error });
      await logMetronFetch(transport, url, started, null, connect.message);
      await recordMetronTransportFailure(connect, transport.now());
      throw connect;
    }
    recordMetronTransportSuccess(transport.now());
    await logMetronFetch(transport, url, started, response.status);
    if (response.status === 304) {
      transport.limiter.observe(response.headers);
      if (cached) return cached.body;
      throw new Error("Metron returned 304");
    }
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      const body = await response.text().catch(() => "");
      const plan = metronStatusPlan({
        status: response.status,
        headers: response.headers,
        body,
        attempt,
        now: transport.now(),
        lane,
      });
      if (plan.action === "retry") {
        const message =
          response.status === 429
            ? `Metron rate limit, backing off ${plan.waitMs}ms.`
            : `Metron returned ${response.status}, backing off ${plan.waitMs}ms.`;
        await writeLog({
          level: "warn",
          source: "covers/backfill",
          message,
          details: { delayMs: plan.waitMs, attempt, status: response.status },
        });
        transport.limiter.defer(plan.waitMs);
        continue;
      }
      if (plan.action === "pause") {
        transport.limiter.observe(response.headers);
        transport.limiter.notePause(plan.resumeAt);
        const snap = transport.limiter.snapshot();
        throw new MetronBudgetError(pauseLabel("Metron", plan.resumeAt), {
          budget: "Metron rate limit",
          count: snap.count,
          resumeAt: plan.resumeAt,
        });
      }
      throw new Error(`Metron returned ${response.status}`);
    }
    if (!response.ok) throw new Error(`Metron returned ${response.status}`);
    transport.limiter.observe(response.headers);
    const json = (await response.json()) as MetronPage;
    if (cacheKey) {
      const modified = response.headers.get("last-modified");
      const etag = response.headers.get("etag");
      if (modified || etag) detailCache.set(cacheKey, { modified, etag, body: json });
      else detailCache.delete(cacheKey);
    }
    return json;
  }
}

/** Same request path the cover client uses, including retries, 304, and the daily count. */
export async function requestMetronJson(transport: MetronTransport, pathOrUrl: string): Promise<MetronPage> {
  return getJson(transport, pathOrUrl);
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

/** A relaunch's legacy number, such as Captain America #783. Short issue numbers stay on `number`. */
export function legacyMetronNumber(number: string): boolean {
  return /^\d{3,}$/.test(number.trim());
}

/**
 * Issue list query. `primary` is series name plus number.
 * `alt-number` is the legacy number. `alt-series` searches the name and its alternate names.
 * https://metron-project.github.io/blog/july-2026-update
 * https://metron-project.github.io/blog/metroninfo-v1-1
 */
export function metronIssueQuery(
  seriesName: string,
  number: string,
  seriesYearBegan: number | null,
  kind: "primary" | "alt-number" | "alt-series",
  volume?: number | null,
): string | null {
  const params = new URLSearchParams();
  const name = seriesName.trim();
  const issue = number.trim();
  if (kind === "alt-series") {
    if (name) params.set("series_q", name);
  } else if (name) params.set("series_name", name);
  if (kind === "alt-number") {
    if (issue) params.set("alt_number", issue);
  } else if (issue) params.set("number", issue);
  if (seriesYearBegan != null) params.set("series_year_began", String(seriesYearBegan));
  else if (kind === "primary" && volume != null) params.set("volume", String(volume));
  if ([...params.keys()].length === 0) return null;
  return `/issue/?${params.toString()}`;
}

/** One follow-up after `series_name` plus `number` misses. */
export function metronIssueFollowUp(seriesName: string, number: string, seriesYearBegan: number | null): string | null {
  const kind = legacyMetronNumber(number) ? "alt-number" : "alt-series";
  const follow = metronIssueQuery(seriesName, number, seriesYearBegan, kind);
  const primary = metronIssueQuery(seriesName, number, seriesYearBegan, "primary");
  if (!follow || follow === primary) return null;
  return follow;
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
    async issuesByName(seriesName, number, seriesYearBegan, volume) {
      const primary = metronIssueQuery(seriesName, number, seriesYearBegan, "primary", volume);
      if (!primary) return [];
      let hits = (await collect(transport, primary, mapIssue)) as MetronIssueHit[];
      if (hits.length > 0) return hits;
      // A volume filter is retried by the caller. A year is too. Spend the extra request on a legacy number, or on alternate names once the year is gone.
      if (volume != null && seriesYearBegan == null) return hits;
      if (!legacyMetronNumber(number) && seriesYearBegan != null) return hits;
      const follow = metronIssueFollowUp(seriesName, number, seriesYearBegan);
      if (!follow) return hits;
      return (await collect(transport, follow, mapIssue)) as MetronIssueHit[];
    },
    async searchSeries(name, query?: MetronSeriesQuery) {
      const params = new URLSearchParams({ name });
      if (query?.volume != null) params.set("volume", String(query.volume));
      if (query?.yearBegan != null) params.set("year_began", String(query.yearBegan));
      const hits = await collect(transport, `/series/?${params.toString()}`, mapSeries);
      return hits as MetronSeriesHit[];
    },
    async issuesByIsbn(isbn) {
      const hits = await collect(transport, `/issue/?isbn=${encodeURIComponent(isbn)}`, mapIssue);
      return hits as MetronIssueHit[];
    },
    async searchSeriesByType(name, seriesType) {
      const params = new URLSearchParams({ name, series_type: seriesType });
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

/** One list request: series name, issue number, and series year. No `alt_number`, `series_q`, or next page. */
export async function metronIssuesByNameOnce(
  transport: MetronTransport,
  seriesName: string,
  number: string,
  seriesYearBegan: number | null,
): Promise<MetronIssueHit[]> {
  const path = metronIssueQuery(seriesName, number, seriesYearBegan, "primary");
  if (!path) return [];
  const body = await requestMetronJson(transport, path);
  const hits: MetronIssueHit[] = [];
  const rows = Array.isArray(body.results) ? body.results : [];
  for (const row of rows) {
    const hit = mapIssue(row);
    if (!hit) continue;
    hits.push(hit);
    if (hits.length >= 12) break;
  }
  return hits;
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

/** Base number, with a variant mark when the row is a cover, printing, facsimile, or `variant_of`. */
export function metronSeriesRunLabel(value: unknown): string | null {
  const number = readMetronIssueNumber(value);
  if (!number) return null;
  if (isVariantDescriptor(number) || !metronVariantRecord(value)) return number;
  return `${number} [variant]`;
}

function metronVariantRecord(value: unknown): boolean {
  const row = record(value);
  if (!row) return false;
  const parent = row.variant_of ?? row.variantOf;
  if (typeof parent === "number" && parent > 0) return true;
  if (typeof parent === "string" && parent.trim() && parent.trim() !== "0") return true;
  const variant = text(row.variant) ?? text(record(row.variant)?.name) ?? text(row.variant_name);
  if (variant && !/^(none|regular|base)$/i.test(variant)) return true;
  return false;
}

/**
 * Prefer a finished issue list of distinct base numbers. Variant rows do not
 * inflate the length. A truncated list with a larger real `issue_count` still
 * falls back to that count.
 */
export function selectMetronSeriesRun(args: {
  numbers: string[];
  issueCount: number | null;
  complete: boolean;
}): { numbers: string[]; issueCount: number | null } | null {
  const numbers = distinctIssueLabels(args.numbers);
  const issueCount = catalogBaseCount(args.numbers, catalogIssueCount(args.issueCount));
  if (args.complete && numbers.length > 0) return { numbers, issueCount };
  if (!args.complete && issueCount != null && issueCount > numbers.length) return { numbers: [], issueCount };
  if (numbers.length > 0) return { numbers, issueCount };
  if (issueCount != null) return { numbers: [], issueCount };
  return null;
}

function listTotal(body: MetronPage): number | null {
  const row = record(body);
  if (!row) return null;
  return catalogIssueCount(row.count) ?? readMetronIssueCount(body);
}

/** Stored series id. Pages `/series/{id}/issue_list/` and does not load the series detail. */
export async function fetchMetronSeriesRun(
  transport: MetronTransport,
  seriesId: string,
): Promise<{ numbers: string[]; issueCount: number | null } | null> {
  if (!/^\d+$/.test(seriesId) || seriesId === "0") return null;
  const numbers: string[] = [];
  let complete = true;
  let issueCount: number | null = null;
  let next: string | null = `/series/${encodeURIComponent(seriesId)}/issue_list/`;
  for (let page = 0; page < SERIES_RUN_PAGES && next; page += 1) {
    const body = await getJson(transport, next);
    if (issueCount == null) issueCount = listTotal(body);
    for (const row of body.results ?? []) {
      const number = metronSeriesRunLabel(row);
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
