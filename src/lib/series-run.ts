import { fetchComicVineIssueCount } from "@/lib/catalog/match-search";
import { fetchGcdSeriesRun } from "@/lib/catalog/gcd";
import { fetchMetronSeriesRun, metronBasicAuth, metronTransport } from "@/lib/covers/metron-client";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import type { CatalogRun } from "@/lib/series-view";
import { getSettings } from "@/lib/settings/service";

export const SERIES_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type RunSource = "metron" | "gcd" | "comicvine";

type CacheRow = {
  numbers: string[];
  issueCount: number | null;
  fetchedAt: string;
};

export type SeriesRunCache = {
  read(key: string): Promise<CacheRow | null>;
  write(key: string, row: CacheRow): Promise<void>;
};

export type SeriesRunIdentity = {
  metronSeriesId: string | null;
  gcdSeriesId: string | null;
  comicvineSeriesId: string | null;
};

type RunPayload = { numbers: string[]; issueCount: number | null };

type ResolveOptions = {
  cache?: SeriesRunCache;
  now?: () => number;
  loadMetron?: (id: string) => Promise<RunPayload | null>;
  loadGcd?: (id: string) => Promise<RunPayload | null>;
  loadComicVine?: (id: string) => Promise<RunPayload | null>;
};

export function seriesRunIdentity(
  comics: Array<{ metronSeriesId?: string | null; gcdSeriesId?: string | null; comicvineSeriesId?: string | null }>,
): SeriesRunIdentity {
  return {
    metronSeriesId: mostCommonId(comics.map((comic) => comic.metronSeriesId)),
    gcdSeriesId: mostCommonId(comics.map((comic) => comic.gcdSeriesId)),
    comicvineSeriesId: mostCommonId(comics.map((comic) => comic.comicvineSeriesId)),
  };
}

export function seriesRunCacheKey(source: RunSource, id: string): string {
  return `series-run:${source}:${id}`;
}

/**
 * Metron issue list, then GCD, then Comic Vine. A fresh cache is reused for a week.
 * A failed refresh keeps the previous cache. Null when every source is unknown.
 */
export async function resolveSeriesRun(identity: SeriesRunIdentity, options: ResolveOptions = {}): Promise<CatalogRun | null> {
  const cache = options.cache ?? prismaSeriesRunCache;
  const now = options.now ?? (() => Date.now());
  const sources: Array<{ source: RunSource; id: string | null; load: (id: string) => Promise<RunPayload | null> }> = [
    { source: "metron", id: identity.metronSeriesId, load: options.loadMetron ?? loadMetronRun },
    { source: "gcd", id: identity.gcdSeriesId, load: options.loadGcd ?? loadGcdRun },
    { source: "comicvine", id: identity.comicvineSeriesId, load: options.loadComicVine ?? loadComicVineRun },
  ];
  for (const source of sources) {
    if (!source.id) continue;
    const key = seriesRunCacheKey(source.source, source.id);
    const cached = await readCache(cache, key);
    if (cached && fresh(cached.fetchedAt, now())) return toRun(cached);
    try {
      const loaded = await source.load(source.id);
      if (loaded && hasRun(loaded)) {
        const row: CacheRow = {
          numbers: loaded.numbers,
          issueCount: loaded.issueCount,
          fetchedAt: new Date(now()).toISOString(),
        };
        await writeCache(cache, key, row, source.source, source.id);
        return toRun(row);
      }
      if (cached) return toRun(cached);
    } catch {
      if (cached) return toRun(cached);
    }
  }
  return null;
}

export const prismaSeriesRunCache: SeriesRunCache = {
  async read(key) {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    return parseCache(row?.plain ?? null);
  },
  async write(key, row) {
    const plain = JSON.stringify(row);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, secret: null, plain },
      update: { secret: null, plain },
    });
  },
};

export function parseCache(plain: string | null): CacheRow | null {
  if (!plain) return null;
  try {
    const value = JSON.parse(plain) as { numbers?: unknown; issueCount?: unknown; fetchedAt?: unknown };
    if (!value || typeof value !== "object" || typeof value.fetchedAt !== "string") return null;
    const numbers = Array.isArray(value.numbers) ? value.numbers.filter((item): item is string => typeof item === "string") : [];
    const issueCount = typeof value.issueCount === "number" && Number.isInteger(value.issueCount) && value.issueCount > 0 ? value.issueCount : null;
    return { numbers, issueCount, fetchedAt: value.fetchedAt };
  } catch {
    return null;
  }
}

function fresh(fetchedAt: string, now: number): boolean {
  const then = Date.parse(fetchedAt);
  if (Number.isNaN(then)) return false;
  const age = now - then;
  return age >= 0 && age < SERIES_RUN_MAX_AGE_MS;
}

function hasRun(run: RunPayload): boolean {
  return run.numbers.length > 0 || (run.issueCount != null && run.issueCount > 0);
}

function toRun(row: CacheRow): CatalogRun {
  return { numbers: row.numbers, issueCount: row.issueCount };
}

async function readCache(cache: SeriesRunCache, key: string): Promise<CacheRow | null> {
  try {
    return await cache.read(key);
  } catch {
    return null;
  }
}

async function writeCache(cache: SeriesRunCache, key: string, row: CacheRow, source: RunSource, id: string): Promise<void> {
  try {
    await cache.write(key, row);
  } catch {
    return;
  }
  const detail = row.numbers.length > 0 ? `${row.numbers.length} issues` : `count ${row.issueCount}`;
  const name = source === "comicvine" ? "Comic Vine" : source === "gcd" ? "GCD" : "Metron";
  await writeLog({
    level: "info",
    source,
    message: `Cached ${name} series ${id} (${detail}).`,
  });
}

async function loadMetronRun(id: string): Promise<RunPayload | null> {
  if (!(await metronBasicAuth())) return null;
  return fetchMetronSeriesRun(await metronTransport(), id);
}

async function loadGcdRun(id: string): Promise<RunPayload | null> {
  return fetchGcdSeriesRun(id);
}

async function loadComicVineRun(id: string): Promise<RunPayload | null> {
  const apiKey = (await getSettings()).comicvine.apiKey;
  if (!apiKey) return null;
  const issueCount = await fetchComicVineIssueCount(apiKey, id);
  return issueCount == null ? null : { numbers: [], issueCount };
}

function mostCommonId(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    const id = cleanId(value);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function cleanId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,12}$/.test(trimmed) || trimmed === "0") return null;
  return trimmed;
}
