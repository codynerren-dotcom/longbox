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
import { fetchMetronIssueBody, legacyMetronNumber, listMetronIssueRows, metronIssueFollowUp, type MetronTransport } from "@/lib/covers/metron-client";
import { retryAfterFromMessage, retryAfterMs } from "@/lib/covers/limiter";
import { recordFetch } from "@/lib/log/api";
import { catalogNameQueries, catalogSeriesQuery, collectedIssueToken, collectedSearchNames, isbnDigits, isCollected, metronSeriesType, rankSeriesHits, resolveShelfFormat, seriesNamesMatch, seriesSoloTitle, tradeSearchSeries, volumeNumber } from "@/lib/shelf-format";

const CV_BASE = "https://comicvine.gamespot.com/api";

export async function searchMetronMatches(
  transport: MetronTransport,
  query: string,
  barcode: string,
  mode: "query" | "barcode",
  shelfFormat?: string | null,
  shelfSeries?: string | null,
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
  const token = collectedIssueToken(parsed.issueNo);
  const effective = isCollected(format) ? format : token?.format ?? format;
  const typeName = isCollected(effective) ? metronSeriesType(effective) : null;
  if (typeName) {
    const seriesName = catalogSeriesQuery(tradeSearchSeries(parsed.series) || parsed.series, shelfSeries).name || parsed.series;
    const number = volumeNumber(parsed.issueNo) ?? token?.number ?? null;
    if (!seriesName) return [];
    const hits: MatchHit[] = [];
    for (const name of collectedSearchNames(seriesName, effective)) {
      const direct = new URLSearchParams({ series_name: name, series_type: typeName });
      if (number) direct.set("number", number);
      const listed = await listMetronIssueRows(transport, `/issue/?${direct.toString()}`);
      for (const issue of listed) {
        if (!collectedIssueFits(issue, typeName, seriesName)) continue;
        const hit = mapMetronMatchHit(issue);
        if (hit && !hits.some((item) => item.id === hit.id)) hits.push(hit);
      }
      if (hits.length > 0) break;
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
  const series = catalogSeriesQuery(parsed.series, shelfSeries);
  const names = dedupeNames(series.name ? [series.name, ...catalogNameQueries(series.name)] : []);
  let rows: unknown[] = [];
  for (const name of names) {
    const params = metronNameParams(name, parsed.issueNo, parsed.year, series);
    rows = params.size > 0 ? await listMetronIssueRows(transport, `/issue/?${params.toString()}`) : [];
    if (rows.length === 0 && (params.has("volume") || params.has("series_year_began"))) {
      params.delete("volume");
      params.delete("series_year_began");
      if (params.size > 0) rows = await listMetronIssueRows(transport, `/issue/?${params.toString()}`);
    }
    if (rows.length > 0) break;
  }
  if (rows.length === 0 && series.name) {
    const year = legacyMetronNumber(parsed.issueNo ?? "") ? (series.yearBegan ?? (series.volume == null ? parsed.year : null)) : null;
    const follow = metronIssueFollowUp(series.name, parsed.issueNo ?? "", year);
    if (follow) rows = await listMetronIssueRows(transport, follow);
  }
  const hits = rows.map(mapMetronMatchHit).filter((hit): hit is MatchHit => hit !== null);
  return orderMatchHits(
    rankSeriesHits(hits, { volume: series.volume, yearBegan: series.yearBegan, shelfYear: series.yearBegan == null && series.volume == null ? parsed.year : null }),
    parsed.year,
  );
}

/** Volume when the title has one. Otherwise the series start year, then the shelf year. One of those, on the same request. */
function collectedIssueFits(row: unknown, typeName: string, seriesName: string): boolean {
  if (!row || typeof row !== "object") return false;
  const series = (row as { series?: unknown }).series;
  const record = series && typeof series === "object" ? (series as { name?: unknown; series_type?: unknown }) : null;
  const name = typeof record?.name === "string" ? record.name : typeof series === "string" ? series : "";
  if (name && !seriesNamesMatch(seriesName, name)) return false;
  const type = seriesTypeLabel(record?.series_type);
  if (type && type.toLowerCase() !== typeName.toLowerCase()) return false;
  return true;
}

function seriesTypeLabel(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function metronNameParams(
  name: string,
  issueNo: string | null,
  shelfYear: number | null,
  series: { volume: number | null; yearBegan: number | null },
): URLSearchParams {
  const params = new URLSearchParams();
  if (name) params.set("series_name", name);
  if (issueNo) params.set("number", issueNo);
  if (series.yearBegan != null) params.set("series_year_began", String(series.yearBegan));
  else if (series.volume != null) params.set("volume", String(series.volume));
  else if (shelfYear != null) params.set("series_year_began", String(shelfYear));
  return params;
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
  shelfSeries?: string | null;
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
  const series = catalogSeriesQuery(parsed.series, args.shelfSeries);
  const volumes = rankComicVineVolumes(
    asRows(
      await comicVineGet(fetchImpl, args.apiKey, "/search/", {
        resources: "volume",
        query: series.name || parsed.series || args.query.trim(),
        limit: "5",
        field_list: "id,name,start_year,publisher",
      }),
    ),
    series.yearBegan ?? parsed.year,
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
        query: [series.name || parsed.series, parsed.issueNo ? `#${parsed.issueNo}` : "", parsed.year ?? ""].filter(Boolean).join(" "),
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

function volumeStartYear(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const year = (value as { start_year?: unknown }).start_year;
  if (typeof year === "number" && Number.isInteger(year)) return year;
  if (typeof year === "string" && /^(?:18|19|20)\d{2}$/.test(year.trim())) return Number.parseInt(year.trim(), 10);
  return null;
}

/** Keep the volume whose start year is the series year or the shelf year. One issue request in the common case. */
function rankComicVineVolumes(rows: unknown[], target: number | null): unknown[] {
  if (target == null || rows.length <= 1) return rows;
  const parsed = rows.map((row, index) => ({ row, index, year: volumeStartYear(row) }));
  const exact = parsed.filter((item) => item.year === target);
  if (exact.length > 0) return exact.map((item) => item.row);
  const earlier = parsed.filter((item) => item.year != null && (item.year as number) <= target);
  if (earlier.length === 0) return rows;
  const best = Math.max(...earlier.map((item) => item.year ?? 0));
  const closest = earlier.filter((item) => item.year === best);
  return closest.length > 0 ? closest.map((item) => item.row) : rows;
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

export async function comicVineVolumeStartYear(apiKey: string, volumeId: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  if (!apiKey.trim() || !/^\d+$/.test(volumeId) || volumeId === "0") return null;
  const result = await comicVineGet(fetchImpl, apiKey, `/volume/4050-${volumeId}/`, { field_list: "start_year" });
  return volumeStartYear(result);
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
