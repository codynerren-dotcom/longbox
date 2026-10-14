import { mapMetronDetails, type MetronDetails } from "@/lib/covers/enrich";
import { fileBudgetStore } from "@/lib/covers/files";
import { budgetDay, retryAfterMs, MetronLimiter } from "@/lib/covers/limiter";
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

export async function metronTransport(): Promise<MetronTransport> {
  const auth = await metronBasicAuth();
  if (!auth) throw new Error("Set Metron username and password in Settings or the environment.");
  return {
    fetch,
    limiter: new MetronLimiter(fileBudgetStore(), () => Date.now(), sleep, () => budgetDay(new Date())),
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
  return {
    id: String(row.id),
    seriesId: series?.id != null ? String(series.id) : null,
    seriesName: seriesName ?? "",
    number: text(row.number) ?? "",
    coverYear: coverYearOf(text(row.cover_date)),
    imageUrl: httpsUrl(text(row.image)),
    label: text(row.issue),
  };
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
      const delay = retryAfterMs(response.headers, transport.now()) ?? Math.min(60_000, 5_000 * 2 ** (attempt - 1));
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
