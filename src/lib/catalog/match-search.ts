import { mapComicVineMatchHit, mapMetronMatchHit, orderMatchHits, variantCoversFrom, type MatchCover, type MatchHit } from "@/lib/catalog/match-hits";
import { catalogIssueCount } from "@/lib/series-view";
import { parseMatchQuery } from "@/lib/catalog/manual-link";
import { ComicVineBudgetError } from "@/lib/catalog/limit-notice";
import {
  comicVineResource,
  emptyComicVineRate,
  noteComicVinePause,
  pauseLabel,
  planComicVineAcquire,
  type ComicVineRateState,
} from "@/lib/catalog/rate-limit";
import { fetchMetronIssueBody, listMetronIssueRows, type MetronTransport } from "@/lib/covers/metron-client";
import { retryAfterFromMessage, retryAfterMs } from "@/lib/covers/limiter";
import { recordFetch } from "@/lib/log/api";
import { catalogNameQueries, isbnDigits, isCollected, metronSeriesType, resolveShelfFormat, seriesNamesMatch, seriesSoloTitle, tradeSearchSeries, volumeNumber } from "@/lib/shelf-format";

const CV_BASE = "https://comicvine.gamespot.com/api";

export async function searchMetronMatches(
  transport: MetronTransport,
  query: string,
  barcode: string,
  mode: "query" | "barcode",
  shelfFormat?: string | null,
): Promise<MatchHit[]> {
  const format = resolveShelfFormat({ shelfFormat });
  if (mode === "barcode") {
    const code = barcode.trim();
    if (!code) return [];
    const isbn = isbnDigits(code);
    if (isbn) {
      const byIsbn = await listMetronIssueRows(transport, `/issue/?isbn=${encodeURIComponent(isbn)}`);
      if (byIsbn.length > 0) return byIsbn.map(mapMetronMatchHit).filter((hit): hit is MatchHit => hit !== null);
    }
    const exact = await listMetronIssueRows(transport, `/issue/?upc=${encodeURIComponent(code)}`);
    const rows = exact.length > 0 ? exact : await listMetronIssueRows(transport, `/issue/?upc_starts_with=${encodeURIComponent(code)}`);
    return rows.map(mapMetronMatchHit).filter((hit): hit is MatchHit => hit !== null);
  }
  const parsed = parseMatchQuery(query);
  if (!parsed.series && !parsed.issueNo) return [];
  const typeName = isCollected(format) ? metronSeriesType(format) : null;
  if (typeName) {
    const seriesName = tradeSearchSeries(parsed.series) || parsed.series;
    const number = volumeNumber(parsed.issueNo);
    if (!seriesName) return [];
    const hits: MatchHit[] = [];
    for (const name of catalogNameQueries(seriesName, { broad: true })) {
      const seriesRows = await listMetronIssueRows(
        transport,
        `/series/?${new URLSearchParams({ name, series_type: typeName }).toString()}`,
      );
      for (const row of seriesRows) {
        const count = catalogIssueCount((row as { issue_count?: unknown }).issue_count);
        const title = rowName(row);
        if (!seriesNamesMatch(seriesName, title) && !(count === 1 && seriesSoloTitle(seriesName, title))) continue;
        const seriesId = idOf(row);
        if (!seriesId) continue;
        const params = new URLSearchParams({ series_id: seriesId });
        if (number) params.set("number", number);
        if (parsed.year != null) params.set("cover_year", String(parsed.year));
        const issues = await listMetronIssueRows(transport, `/issue/?${params.toString()}`);
        for (const issue of issues) {
          const hit = mapMetronMatchHit(issue);
          if (hit && !hits.some((item) => item.id === hit.id)) hits.push(hit);
        }
        if (hits.length >= 12) return orderMatchHits(hits.slice(0, 12), parsed.year);
      }
      if (hits.length > 0) break;
    }
    return orderMatchHits(hits.slice(0, 12), parsed.year);
  }
  const names = dedupeNames(parsed.series ? [parsed.series, ...catalogNameQueries(parsed.series)] : []);
  let rows: unknown[] = [];
  for (const name of names) {
    const params = new URLSearchParams();
    if (name) params.set("series_name", name);
    if (parsed.issueNo) params.set("number", parsed.issueNo);
    if (parsed.year != null) params.set("cover_year", String(parsed.year));
    rows = params.size > 0 ? await listMetronIssueRows(transport, `/issue/?${params.toString()}`) : [];
    if (rows.length === 0 && parsed.year != null) {
      params.delete("cover_year");
      if (params.size > 0) rows = await listMetronIssueRows(transport, `/issue/?${params.toString()}`);
    }
    if (rows.length > 0) break;
  }
  return orderMatchHits(
    rows.map(mapMetronMatchHit).filter((hit): hit is MatchHit => hit !== null),
    parsed.year,
  );
}

let vineMemory: ComicVineRateState = emptyComicVineRate();

/** One Comic Vine request. Tests keep the window in memory and skip the one-second gap. */
export async function reserveComicVineRequest(path: string, now = Date.now()): Promise<void> {
  const resource = comicVineResource(path);
  if (process.env.VITEST === "true") {
    const plan = planComicVineAcquire(vineMemory, now, resource);
    if (plan.kind === "pause") {
      vineMemory = plan.state;
      throw new ComicVineBudgetError(pauseLabel("Comic Vine", plan.hold.resumeAt), {
        budget: plan.hold.budget,
        count: plan.hold.count,
        resumeAt: plan.hold.resumeAt,
      });
    }
    vineMemory = plan.state;
    return;
  }
  const { ensureRateHydrated, readComicVineWindow, saveComicVineWindow } = await import("@/lib/catalog/rate-store");
  await ensureRateHydrated();
  const plan = planComicVineAcquire(readComicVineWindow(), now, resource);
  if (plan.kind === "pause") {
    await saveComicVineWindow(plan.state);
    throw new ComicVineBudgetError(pauseLabel("Comic Vine", plan.hold.resumeAt), {
      budget: plan.hold.budget,
      count: plan.hold.count,
      resumeAt: plan.hold.resumeAt,
    });
  }
  await saveComicVineWindow(plan.state);
  if (plan.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, plan.waitMs));
}

export async function pauseComicVineUntil(resumeAt: number): Promise<void> {
  if (process.env.VITEST === "true") {
    vineMemory = noteComicVinePause(vineMemory, resumeAt);
    return;
  }
  const { readComicVineWindow, saveComicVineWindow } = await import("@/lib/catalog/rate-store");
  await saveComicVineWindow(noteComicVinePause(readComicVineWindow(), resumeAt));
}

async function comicVineGet(fetchImpl: typeof fetch, apiKey: string, path: string, params: Record<string, string>): Promise<unknown> {
  await reserveComicVineRequest(path);
  const url = new URL(path.startsWith("http") ? path : `${CV_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "longbox/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    await recordFetch({
      source: "comicvine",
      url: url.toString(),
      startedAt: started,
      status: null,
      error: error instanceof Error ? error.message : "Request failed.",
    });
    throw error;
  }
  await recordFetch({ source: "comicvine", url: url.toString(), startedAt: started, status: response.status });
  if (response.status === 420 || response.status === 429) {
    const body = await response.text().catch(() => "");
    const delay = retryAfterMs(response.headers, Date.now()) ?? retryAfterFromMessage(body) ?? 60 * 60 * 1000;
    const resumeAt = Date.now() + delay;
    await pauseComicVineUntil(resumeAt);
    throw new ComicVineBudgetError(pauseLabel("Comic Vine", resumeAt), {
      budget: "Comic Vine",
      count: null,
      resumeAt,
    });
  }
  if (!response.ok) throw new Error(`Comic Vine returned ${response.status}`);
  const body = (await response.json()) as { status_code?: number; error?: string; results?: unknown };
  if (body.status_code === 107) {
    const resumeAt = Date.now() + 60 * 60 * 1000;
    await pauseComicVineUntil(resumeAt);
    throw new ComicVineBudgetError(pauseLabel("Comic Vine", resumeAt), {
      budget: "Comic Vine",
      count: null,
      resumeAt,
    });
  }
  if (body.status_code != null && body.status_code !== 1) {
    throw new Error(body.error || `Comic Vine returned status ${body.status_code}.`);
  }
  return body.results ?? body;
}

function asRows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function searchComicVineMatches(args: {
  apiKey: string;
  query: string;
  barcode: string;
  mode: "query" | "barcode";
  fetchImpl?: typeof fetch;
}): Promise<MatchHit[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  if (args.mode === "barcode") {
    const code = args.barcode.trim();
    if (!code) return [];
    const results = await comicVineGet(fetchImpl, args.apiKey, "/search/", {
      resources: "issue",
      query: code,
      limit: "12",
      field_list: "id,name,issue_number,cover_date,image,volume",
    });
    return asRows(results)
      .map((row) => mapComicVineMatchHit(row))
      .filter((hit): hit is MatchHit => hit !== null)
      .slice(0, 12);
  }

  const parsed = parseMatchQuery(args.query);
  if (!parsed.series && !parsed.issueNo) return [];
  const volumes = asRows(
    await comicVineGet(fetchImpl, args.apiKey, "/search/", {
      resources: "volume",
      query: parsed.series || args.query.trim(),
      limit: "5",
      field_list: "id,name,start_year,publisher",
    }),
  );
  const hits: MatchHit[] = [];
  for (const volume of volumes) {
    const row = volume && typeof volume === "object" ? (volume as Record<string, unknown>) : null;
    const volumeId = row && (typeof row.id === "number" || typeof row.id === "string") ? String(row.id) : "";
    if (!/^\d+$/.test(volumeId)) continue;
    const publisher = publisherOf(row?.publisher);
    const filter = parsed.issueNo ? `volume:${volumeId},issue_number:${parsed.issueNo}` : `volume:${volumeId}`;
    const issues = asRows(
      await comicVineGet(fetchImpl, args.apiKey, "/issues/", {
        filter,
        limit: "8",
        field_list: "id,name,issue_number,cover_date,image,volume",
      }),
    );
    for (const issue of issues) {
      const hit = mapComicVineMatchHit(issue, publisher);
      if (hit && !hits.some((item) => item.id === hit.id)) hits.push(hit);
    }
    if (hits.length >= 12) break;
  }
  if (hits.length === 0) {
    const results = asRows(
      await comicVineGet(fetchImpl, args.apiKey, "/search/", {
        resources: "issue",
        query: args.query.trim(),
        limit: "12",
        field_list: "id,name,issue_number,cover_date,image,volume",
      }),
    );
    for (const issue of results) {
      const hit = mapComicVineMatchHit(issue);
      if (hit) hits.push(hit);
    }
  }
  return orderMatchHits(hits.slice(0, 12), parsed.year);
}

function dedupeNames(values: string[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    if (names.some((name) => name.toLowerCase() === trimmed.toLowerCase())) continue;
    names.push(trimmed);
  }
  return names.length > 0 ? names : [""];
}

function rowName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function idOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  const text = String(id);
  return /^\d+$/.test(text) ? text : null;
}

function publisherOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export async function metronCovers(transport: MetronTransport, issueId: string): Promise<MatchCover[]> {
  const body = await fetchMetronIssueBody(transport, issueId);
  return body ? variantCoversFrom(body) : [];
}

export function parseComicVineIssueCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  return catalogIssueCount((value as { count_of_issues?: unknown }).count_of_issues);
}

export async function fetchComicVineIssueCount(apiKey: string, volumeId: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  if (!apiKey.trim() || !/^\d+$/.test(volumeId) || volumeId === "0") return null;
  const result = await comicVineGet(fetchImpl, apiKey, `/volume/4050-${volumeId}/`, { field_list: "count_of_issues" });
  return parseComicVineIssueCount(result);
}

export async function comicVineIssue(apiKey: string, issueId: string, fetchImpl: typeof fetch = fetch): Promise<unknown | null> {
  if (!/^\d+$/.test(issueId)) return null;
  return comicVineGet(fetchImpl, apiKey, `/issue/4000-${issueId}/`, {
    field_list: "id,name,issue_number,cover_date,description,image,volume,associated_images",
  });
}

export async function comicVineCovers(apiKey: string, issueId: string, fetchImpl: typeof fetch = fetch): Promise<MatchCover[]> {
  const result = await comicVineIssue(apiKey, issueId, fetchImpl);
  return result ? variantCoversFrom(result) : [];
}
