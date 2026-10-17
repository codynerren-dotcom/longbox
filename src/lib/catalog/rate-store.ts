import "server-only";

import { hydrateMetronCircuit, METRON_CIRCUIT_BASE_MS } from "@/lib/covers/metron-circuit";
import {
  comicVineUsage,
  emptyComicVineRate,
  emptyGcdRate,
  emptyMetronBudget,
  emptyPace,
  gcdUsage,
  mergeMetronBudget,
  metronUsage,
  normalizeMetronBudget,
  normalizePace,
  type ComicVineRateState,
  type GcdRateState,
  type JobCursor,
  type JobName,
  type MetronBudget,
  type PaceWindow,
  type UsageWindow,
} from "@/lib/catalog/rate-limit";

type MemoryShape = {
  metron: MetronBudget;
  gcd: GcdRateState;
  comicvine: ComicVineRateState;
  circuit: { failures: number; openUntil: number; pauseMs: number } | null;
  jobs: Partial<Record<JobName, JobCursor>>;
  paces: Record<string, PaceWindow>;
};

const memory: MemoryShape = {
  metron: emptyMetronBudget(),
  gcd: emptyGcdRate(),
  comicvine: emptyComicVineRate(),
  circuit: null,
  jobs: {},
  paces: {},
};

let hydrated = process.env.VITEST === "true";
let hydrating: Promise<void> | null = null;
let writing: Promise<void> = Promise.resolve();
let metronEpoch = 0;

function remember(key: string, payload: unknown): void {
  if (key === "metron") {
    metronEpoch += 1;
    memory.metron = normalizeMetronBudget(payload);
  }
  else if (key === "gcd") memory.gcd = normalizeGcd(payload);
  else if (key === "comicvine") memory.comicvine = normalizeComicVine(payload);
  else if (key === "metron-circuit") {
    memory.circuit = normalizeCircuit(payload);
    if (memory.circuit) hydrateMetronCircuit(memory.circuit);
  }
  else if (key.startsWith("pace:")) memory.paces[key.slice("pace:".length)] = normalizePace(payload);
  else if (key === "job:backfill" || key === "job:enrich") {
    const job = key === "job:backfill" ? "backfill" : "enrich";
    const cursor = normalizeJob(payload, job);
    if (cursor) memory.jobs[job] = cursor;
  }
}

export async function ensureRateHydrated(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    const epoch = metronEpoch;
    hydrating = (async () => {
      try {
        const { prisma } = await import("@/lib/db");
        const rows = await prisma.apiWindow.findMany();
        for (const row of rows) {
          if (row.key === "metron") {
            if (metronEpoch !== epoch) continue;
            memory.metron = mergeMetronBudget(memory.metron, normalizeMetronBudget(row.payload));
            continue;
          }
          remember(row.key, row.payload);
        }
      } catch {
        // The table is created by the migration. Until then the process keeps the window in memory.
      } finally {
        hydrated = true;
        hydrating = null;
      }
    })();
  }
  await hydrating;
}

async function writeWindow(key: string, payload: unknown): Promise<void> {
  remember(key, payload);
  if (process.env.VITEST === "true") return;
  writing = writing.then(async () => {
    try {
      const { prisma } = await import("@/lib/db");
      await prisma.apiWindow.upsert({
        where: { key },
        create: { key, payload: payload as object },
        update: { payload: payload as object },
      });
    } catch {
      // The next successful write replaces the row.
    }
  });
  await writing;
}

export function readMetronWindow(): MetronBudget {
  return { ...memory.metron };
}

export async function saveMetronWindow(budget: MetronBudget): Promise<void> {
  await writeWindow("metron", budget);
}

export function readGcdWindow(): GcdRateState {
  return { ...memory.gcd, hits: memory.gcd.hits.slice() };
}

export async function saveGcdWindow(state: GcdRateState): Promise<void> {
  await writeWindow("gcd", state);
}

export function readComicVineWindow(): ComicVineRateState {
  return { ...memory.comicvine, resources: { ...memory.comicvine.resources } };
}

export async function saveComicVineWindow(state: ComicVineRateState): Promise<void> {
  await writeWindow("comicvine", state);
}

export function readCircuitWindow(): { failures: number; openUntil: number; pauseMs: number } | null {
  return memory.circuit ? { ...memory.circuit } : null;
}

export async function saveCircuitWindow(state: { failures: number; openUntil: number; pauseMs: number }): Promise<void> {
  await writeWindow("metron-circuit", state);
}

export function readPaceWindow(name: string): PaceWindow {
  return { ...(memory.paces[name] ?? emptyPace()) };
}

export async function savePaceWindow(name: string, state: PaceWindow): Promise<void> {
  await writeWindow(`pace:${name}`, state);
}

export function readJobWindow(job: JobName): JobCursor | null {
  return memory.jobs[job] ? { ...memory.jobs[job] } : null;
}

export async function saveJobWindow(cursor: JobCursor): Promise<void> {
  await writeWindow(`job:${cursor.job}`, cursor);
}

export async function loadApiUsage(now = Date.now()): Promise<UsageWindow[]> {
  await ensureRateHydrated();
  const signedIn = await gcdSignedIn();
  return [...metronUsage(memory.metron, now), gcdUsage(memory.gcd, now, signedIn), ...comicVineUsage(memory.comicvine, now)];
}

async function gcdSignedIn(): Promise<boolean> {
  try {
    const { gcdAccountSignedIn } = await import("@/lib/catalog/gcd");
    return await gcdAccountSignedIn();
  } catch {
    return memory.gcd.mode === "authenticated";
  }
}

export function normalizeGcd(value: unknown): GcdRateState {
  const row = value && typeof value === "object" ? (value as Partial<GcdRateState>) : {};
  const hits = Array.isArray(row.hits) ? row.hits.filter((time): time is number => typeof time === "number" && time > 0) : [];
  return {
    mode: row.mode === "authenticated" ? "authenticated" : "anonymous",
    hits: hits.sort((a, b) => a - b),
    pausedUntil: typeof row.pausedUntil === "number" && row.pausedUntil > 0 ? row.pausedUntil : null,
    lastSentAt: typeof row.lastSentAt === "number" && row.lastSentAt > 0 ? row.lastSentAt : null,
    strikes: typeof row.strikes === "number" && row.strikes > 0 ? Math.round(row.strikes) : 0,
  };
}

export function normalizeComicVine(value: unknown): ComicVineRateState {
  const row = value && typeof value === "object" ? (value as Partial<ComicVineRateState>) : {};
  const resources: Record<string, number[]> = {};
  if (row.resources && typeof row.resources === "object") {
    for (const [key, times] of Object.entries(row.resources)) {
      if (!Array.isArray(times)) continue;
      const fresh = times.filter((time): time is number => typeof time === "number" && time > 0).sort((a, b) => a - b);
      if (fresh.length > 0) resources[key] = fresh;
    }
  }
  return {
    lastSentAt: typeof row.lastSentAt === "number" && row.lastSentAt > 0 ? row.lastSentAt : null,
    pausedUntil: typeof row.pausedUntil === "number" && row.pausedUntil > 0 ? row.pausedUntil : null,
    resources,
  };
}

function normalizeCircuit(value: unknown): MemoryShape["circuit"] {
  const row = value && typeof value === "object" ? (value as { failures?: unknown; openUntil?: unknown; pauseMs?: unknown }) : {};
  return {
    failures: typeof row.failures === "number" && row.failures > 0 ? Math.round(row.failures) : 0,
    openUntil: typeof row.openUntil === "number" && row.openUntil > 0 ? row.openUntil : 0,
    pauseMs: typeof row.pauseMs === "number" && row.pauseMs > 0 ? row.pauseMs : METRON_CIRCUIT_BASE_MS,
  };
}

function normalizeJob(value: unknown, job: JobName): JobCursor | null {
  const row = value && typeof value === "object" ? (value as Partial<JobCursor>) : {};
  return {
    job,
    cursorId: typeof row.cursorId === "string" && row.cursorId ? row.cursorId : null,
    resumeAt: typeof row.resumeAt === "number" && row.resumeAt > 0 ? row.resumeAt : null,
    reason: typeof row.reason === "string" && row.reason ? row.reason : null,
  };
}

