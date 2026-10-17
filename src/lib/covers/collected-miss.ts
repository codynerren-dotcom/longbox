import { normalizeSeriesName } from "@/lib/shelf-format";

/** Shown on the copy, and reused so the same trade is not asked again for a week. */
export const COLLECTED_METRON_MISS = "not on Metron (no collected-edition series)";

export const COLLECTED_MISS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredCollectedMiss = {
  fetchedAt: string;
  series: string;
  seriesType: string;
};

export type CollectedMissCache = {
  read(key: string): Promise<StoredCollectedMiss | null>;
  write(key: string, row: StoredCollectedMiss): Promise<void>;
};

/** One row per series name and Metron series type. A different type is a different search. */
export function collectedMissKey(series: string, seriesType: string): string {
  return `collected-miss:${normalizeSeriesName(series)}:${seriesType.trim().toLowerCase()}`;
}

let injected: CollectedMissCache | null | undefined;

/** Tests inject a store. Production uses `AppSetting`. Vitest leaves the cache off unless injected. */
export function setCollectedMissCacheForTests(cache: CollectedMissCache | null): void {
  injected = cache;
}

function activeCache(): CollectedMissCache | null {
  if (injected !== undefined) return injected;
  if (process.env.VITEST === "true") return null;
  return prismaCache;
}

const prismaCache: CollectedMissCache = {
  async read(key) {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.appSetting.findUnique({ where: { key } });
    return parseStored(row?.plain ?? null);
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

export async function readCollectedMiss(series: string, seriesType: string): Promise<StoredCollectedMiss | null> {
  const cache = activeCache();
  if (!cache || !series.trim() || !seriesType.trim()) return null;
  try {
    const row = await cache.read(collectedMissKey(series, seriesType));
    if (!row) return null;
    const then = Date.parse(row.fetchedAt);
    if (Number.isNaN(then)) return null;
    const age = Date.now() - then;
    if (age < 0 || age >= COLLECTED_MISS_MAX_AGE_MS) return null;
    return row;
  } catch {
    return null;
  }
}

export async function writeCollectedMiss(series: string, seriesType: string): Promise<void> {
  const cache = activeCache();
  if (!cache || !series.trim() || !seriesType.trim()) return;
  try {
    await cache.write(collectedMissKey(series, seriesType), {
      series,
      seriesType,
      fetchedAt: new Date().toISOString(),
    });
  } catch {
    return;
  }
}

function parseStored(plain: string | null): StoredCollectedMiss | null {
  if (!plain) return null;
  try {
    const value = JSON.parse(plain) as Partial<StoredCollectedMiss>;
    if (!value || typeof value !== "object") return null;
    if (typeof value.series !== "string" || typeof value.seriesType !== "string" || typeof value.fetchedAt !== "string") return null;
    return { series: value.series, seriesType: value.seriesType, fetchedAt: value.fetchedAt };
  } catch {
    return null;
  }
}
