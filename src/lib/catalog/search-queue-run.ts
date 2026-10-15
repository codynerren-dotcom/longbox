import { Prisma } from "@prisma/client";
import { limitBlockFromError } from "@/lib/catalog/limit-notice";
import { linkIssueToCatalog, searchCatalogSource } from "@/lib/catalog/link-issue";
import { runInLane } from "@/lib/catalog/rate-lane";
import { ensureRateHydrated, readCircuitWindow, readComicVineWindow, readGcdWindow, readMetronWindow } from "@/lib/catalog/rate-store";
import {
  alreadyQueuedMessage,
  isQueueKind,
  isQueueSource,
  queueResultHref,
  queueResultMessage,
  queueSourceLabel,
  queueSourceOf,
  queuedMessage,
  readQueuePayload,
  storedMatchHit,
  type QueuePayload,
  type QueueRequest,
  type QueueSource,
} from "@/lib/catalog/search-queue";
import { rematchShelfCopy } from "@/lib/covers/facsimile-rematch";
import { loadGcdIssueHits } from "@/lib/covers/gcd-match";
import { sharedMetronLimiter } from "@/lib/covers/metron-client";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import type { LogSource } from "@/lib/log/types";

let timer: ReturnType<typeof setTimeout> | null = null;
let armChain: Promise<void> = Promise.resolve();
let draining = false;

function skipped(): boolean {
  return process.env.VITEST === "true" || process.env.NEXT_PHASE === "phase-production-build";
}

function logSource(source: string): LogSource {
  if (source === "metron") return "metron";
  if (source === "gcd") return "gcd";
  return "comicvine";
}

function windowResumeAt(source: QueueSource, now: number): number | null {
  if (source === "metron") {
    const circuit = readCircuitWindow();
    const open = circuit && circuit.openUntil > now ? circuit.openUntil : null;
    const paused = readMetronWindow().pausedUntil;
    const rate = paused != null && paused > now ? paused : null;
    if (open != null && rate != null) return Math.max(open, rate);
    return open ?? rate;
  }
  if (source === "gcd") {
    const paused = readGcdWindow().pausedUntil;
    return paused != null && paused > now ? paused : null;
  }
  const paused = readComicVineWindow().pausedUntil;
  return paused != null && paused > now ? paused : null;
}

function futureResume(at: number): number {
  return at > Date.now() ? at : Date.now() + 60_000;
}

function requestPayload(input: QueueRequest): QueuePayload {
  return {
    query: input.query,
    barcode: input.barcode,
    mode: input.mode,
    shelfFormat: input.shelfFormat,
    facsimile: input.facsimile,
    shelfSeries: input.shelfSeries,
    gcdRef: input.gcdRef,
    hit: input.hit ?? null,
    useCover: input.useCover,
    fillMissing: input.fillMissing,
    overwrite: input.overwrite,
    coverImageUrl: input.coverImageUrl,
  };
}

export async function enqueueSearch(input: QueueRequest): Promise<{ ok: boolean; message: string; queued: boolean; resumeAt: number }> {
  const comicId = typeof input?.comicId === "string" ? input.comicId.trim() : "";
  if (!comicId || !isQueueSource(input.source) || !isQueueKind(input.kind) || !(input.resumeAt > 0)) {
    return { ok: false, message: comicId ? "That search cannot be queued." : "That issue is not on the shelf.", queued: false, resumeAt: 0 };
  }
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true, series: true, issue: true, issueNo: true },
  });
  if (!comic) return { ok: false, message: "That issue is not on the shelf.", queued: false, resumeAt: 0 };
  const label = `${comic.series} #${comic.issueNo || comic.issue || "?"}`;
  try {
    await prisma.searchQueue.create({
      data: {
        comicId: comic.id,
        source: input.source,
        kind: input.kind,
        label,
        resumeAt: new Date(input.resumeAt),
        payload: requestPayload(input) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.searchQueue.findUnique({
        where: { comicId_source: { comicId: comic.id, source: input.source } },
      });
      if (existing) {
        return {
          ok: true,
          queued: false,
          resumeAt: existing.resumeAt.getTime(),
          message: alreadyQueuedMessage({ label: existing.label, source: existing.source, resumeAt: existing.resumeAt.getTime() }),
        };
      }
    }
    throw error;
  }
  await armSearchQueue();
  return { ok: true, queued: true, resumeAt: input.resumeAt, message: queuedMessage(input.resumeAt) };
}

export async function cancelQueuedSearch(id: string): Promise<{ ok: boolean; message: string }> {
  const existing = await prisma.searchQueue.findUnique({ where: { id } });
  if (!existing) return { ok: false, message: "That search is no longer queued." };
  await prisma.searchQueue.delete({ where: { id } });
  await armSearchQueue();
  return { ok: true, message: "Cancelled." };
}

export async function drainDueSearches(now = Date.now()): Promise<number> {
  if (skipped() || draining) return 0;
  draining = true;
  try {
    return await runInLane("interactive", async () => {
      await ensureRateHydrated();
      const due = await prisma.searchQueue.findMany({
        where: { resumeAt: { lte: new Date(now) } },
        orderBy: [{ resumeAt: "asc" }, { createdAt: "asc" }],
      });
      for (const row of due) await runQueued(row);
      return due.length;
    });
  } finally {
    draining = false;
  }
}

async function runQueued(row: {
  id: string;
  comicId: string;
  source: string;
  kind: string;
  label: string;
  payload: Prisma.JsonValue;
}): Promise<void> {
  if (!isQueueSource(row.source)) {
    await prisma.searchQueue.delete({ where: { id: row.id } }).catch(() => undefined);
    return;
  }
  const held = windowResumeAt(row.source, Date.now());
  if (held) {
    await prisma.searchQueue.update({ where: { id: row.id }, data: { resumeAt: new Date(futureResume(held)) } });
    return;
  }
  const payload = readQueuePayload(row.payload);
  try {
    if (row.kind === "relink") {
      await runRelink({ id: row.id, comicId: row.comicId, source: row.source, label: row.label }, payload);
      return;
    }
    const hits =
      payload.gcdRef && row.source === "gcd"
        ? await loadGcdIssueHits(payload.gcdRef)
        : await searchCatalogSource({
            source: row.source,
            query: payload.query ?? "",
            barcode: payload.barcode ?? "",
            mode: payload.mode === "barcode" ? "barcode" : "query",
            shelfFormat: payload.shelfFormat,
            shelfSeries: payload.shelfSeries,
            facsimile: payload.facsimile,
            comicId: row.comicId,
          });
    await finish(row, hits.length > 0 ? "matched" : "empty");
  } catch (error) {
    const block = limitBlockFromError(error, sharedMetronLimiter().snapshot());
    if (block) {
      await prisma.searchQueue.update({ where: { id: row.id }, data: { resumeAt: new Date(futureResume(block.resumeAt)) } });
      return;
    }
    await writeLog({
      level: "warn",
      source: logSource(row.source),
      message: `Queued search for ${row.label} on ${queueSourceLabel(row.source)} failed.`,
      details: { queued: true, comicId: row.comicId, href: queueResultHref(row.comicId) },
    });
    await prisma.searchQueue.delete({ where: { id: row.id } }).catch(() => undefined);
  }
}

async function runRelink(
  row: { id: string; comicId: string; source: QueueSource; label: string },
  payload: QueuePayload,
): Promise<void> {
  const source = row.source;
  const hit = storedMatchHit(payload.hit);
  if (hit && hit.source === source) {
    const result = await linkIssueToCatalog({
      comicId: row.comicId,
      source: row.source,
      hit,
      useCover: Boolean(payload.useCover),
      fillMissing: payload.fillMissing !== false,
      overwrite: Boolean(payload.overwrite),
      coverImageUrl: payload.coverImageUrl ?? null,
    });
    if (!result.ok && result.notice) {
      const again = windowResumeAt(row.source, Date.now()) ?? Date.now() + 60_000;
      await prisma.searchQueue.update({ where: { id: row.id }, data: { resumeAt: new Date(futureResume(again)) } });
      return;
    }
    await finish(row, result.ok ? "matched" : "empty");
    return;
  }
  const result = await rematchShelfCopy(row.comicId);
  if (result.outcome === "matched") {
    await finish(row, "matched");
    return;
  }
  const block = result.limitBlocks.find((item) => queueSourceOf(item.source) === row.source) ?? result.limitBlocks[0];
  if (block && block.resumeAt > Date.now()) {
    await prisma.searchQueue.update({ where: { id: row.id }, data: { resumeAt: new Date(futureResume(block.resumeAt)) } });
    return;
  }
  await finish(row, "empty");
}

async function finish(
  row: { id: string; comicId: string; source: string; label: string },
  status: "matched" | "empty",
): Promise<void> {
  const message = queueResultMessage({ label: row.label, source: row.source }, status);
  await writeLog({
    level: status === "matched" ? "info" : "warn",
    source: logSource(row.source),
    message,
    details: { queued: true, comicId: row.comicId, href: queueResultHref(row.comicId) },
  });
  await prisma.searchQueue.delete({ where: { id: row.id } }).catch(() => undefined);
}

function scheduleAt(at: number): void {
  const wait = Math.max(1_000, at - Date.now());
  timer = setTimeout(() => {
    timer = null;
    void drainDueSearches().finally(() => {
      void armSearchQueue();
    });
  }, wait);
  timer.unref?.();
}

async function armOnce(): Promise<void> {
  const next = await prisma.searchQueue.findFirst({ orderBy: [{ resumeAt: "asc" }, { createdAt: "asc" }] });
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!next) return;
  if (next.resumeAt.getTime() <= Date.now()) {
    await drainDueSearches();
    const later = await prisma.searchQueue.findFirst({ orderBy: [{ resumeAt: "asc" }, { createdAt: "asc" }] });
    if (!later || later.resumeAt.getTime() <= Date.now()) return;
    scheduleAt(later.resumeAt.getTime());
    return;
  }
  scheduleAt(next.resumeAt.getTime());
}

/** Wake the queue at the next resume time. Due rows run before this returns. */
export function armSearchQueue(): Promise<void> {
  if (skipped()) return Promise.resolve();
  const run = armChain.then(armOnce);
  armChain = run.catch(() => undefined);
  return run;
}
