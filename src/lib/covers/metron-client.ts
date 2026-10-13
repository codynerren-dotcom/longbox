import { coverYearOf } from "@/lib/covers/match";
import { retryAfterMs, type MetronLimiter } from "@/lib/covers/limiter";
import { MetronBudgetError, type CoverLookup, type MetronIssueHit, type MetronSeriesHit } from "@/lib/covers/types";
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
    const response = await transport.fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: basicAuthHeader(transport.username, transport.password),
        "User-Agent": "longbox/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      attempt += 1;
      transport.limiter.observe(response.headers);
      const delay = retryAfterMs(response.headers, transport.now()) ?? Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      if (attempt >= 3 || delay > 120_000) {
        throw new MetronBudgetError("Metron rate limit reached. Stopping so the run can resume.");
      }
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

export async function fetchMetronIssue(transport: MetronTransport, metronIssueId: string): Promise<MetronIssueHit | null> {
  if (!/^\d+$/.test(metronIssueId)) return null;
  const body = await getJson(transport, `/issue/${metronIssueId}/`);
  const row = (body as { results?: unknown }).results ?? body;
  return mapIssue(row);
}
