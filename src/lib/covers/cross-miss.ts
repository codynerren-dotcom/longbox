import type { CrossVia } from "@/lib/covers/cross-link";
import type { MetronIssueHit } from "@/lib/covers/types";

/** A failed name follow-up is reused for a week. A hit does not spend another Metron request. */
export const CROSS_MISS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredCrossMiss = {
  fetchedAt: string;
  status: "miss" | "candidates";
  via: CrossVia;
  foreignId: string;
  reason: string;
  hits: MetronIssueHit[];
};

export type CrossMissCache = {
  read(key: string): Promise<StoredCrossMiss | null>;
  write(key: string, row: StoredCrossMiss): Promise<void>;
};

/** One row per Comic Vine id and GCD id pair. A new id is a new search. */
export function crossMissKey(comicVineId: string | null, gcdId: string | null): string {
  return `cross-miss:cv:${comicVineId ?? "0"}:gcd:${gcdId ?? "0"}`;
}

let injected: CrossMissCache | null | undefined;

/** Tests inject a store. Production uses `AppSetting`. Vitest leaves the cache off unless injected. */
export function setCrossMissCacheForTests(cache: CrossMissCache | null): void {
  injected = cache;
}

function activeCache(): CrossMissCache | null {
  if (injected !== undefined) return injected;
  if (process.env.VITEST === "true") return null;
  return prismaCache;
}

const prismaCache: CrossMissCache = {
  async read(key) {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.appSetting.findUnique({ where: { key } });
    return parseStoredCrossMiss(row?.plain ?? null);
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

export async function readCrossMiss(comicVineId: string | null, gcdId: string | null): Promise<StoredCrossMiss | null> {
  const cache = activeCache();
  if (!cache) return null;
  try {
    const row = await cache.read(crossMissKey(comicVineId, gcdId));
    if (!row) return null;
    const then = Date.parse(row.fetchedAt);
    if (Number.isNaN(then)) return null;
    const age = Date.now() - then;
    if (age < 0 || age >= CROSS_MISS_MAX_AGE_MS) return null;
    return row;
  } catch {
    return null;
  }
}

export async function writeCrossMiss(comicVineId: string | null, gcdId: string | null, row: Omit<StoredCrossMiss, "fetchedAt">): Promise<void> {
  const cache = activeCache();
  if (!cache) return;
  try {
    await cache.write(crossMissKey(comicVineId, gcdId), { ...row, fetchedAt: new Date().toISOString() });
  } catch {
    return;
  }
}

function parseStoredCrossMiss(plain: string | null): StoredCrossMiss | null {
  if (!plain) return null;
  try {
    const value = JSON.parse(plain) as Partial<StoredCrossMiss>;
    if (!value || typeof value !== "object") return null;
    if (value.status !== "miss" && value.status !== "candidates") return null;
    if (value.via !== "cv_id" && value.via !== "gcd_id") return null;
    if (typeof value.foreignId !== "string" || typeof value.reason !== "string" || typeof value.fetchedAt !== "string") return null;
    const hits = Array.isArray(value.hits) ? value.hits.filter((hit) => hit && typeof hit === "object" && typeof (hit as MetronIssueHit).id === "string") : [];
    return { fetchedAt: value.fetchedAt, status: value.status, via: value.via, foreignId: value.foreignId, reason: value.reason, hits: hits as MetronIssueHit[] };
  } catch {
    return null;
  }
}
