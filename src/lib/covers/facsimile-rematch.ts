import { mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGcdCatalog, GcdBudgetError } from "@/lib/catalog/gcd";
import { limitBlockFromError, limitNotices, type LimitBlock } from "@/lib/catalog/limit-notice";
import { hintFromBlocks, type QueueSeed } from "@/lib/catalog/search-queue";
import { runInLane } from "@/lib/catalog/rate-lane";
import { readManualLink } from "@/lib/catalog/manual-link";
import { coverPublicPath } from "@/lib/covers/backfill";
import { budgetPauseMessage, recordBudgetPause } from "@/lib/covers/budget-pause";
import { calendarDay, detectEdition, suspectMatchReason } from "@/lib/covers/edition";
import { METRON_FIELDS, readFieldSources } from "@/lib/covers/enrich";
import { editionOutcome, runFacsimilePass, type RematchOutcome } from "@/lib/covers/facsimile-once";
import { FACSIMILE_REMATCH_KEY, readCatalogYears, readPrintingCovers, writeCatalogYear, writePrintingCover } from "@/lib/covers/facsimile-years";
import { coversDir, downloadCover } from "@/lib/covers/files";
import { resolveGcdCover } from "@/lib/covers/gcd-match";
import { readEditionJob, writeEditionJob } from "@/lib/covers/job-state";
import { resolveCover, savedPrintingCover } from "@/lib/covers/match";
import { armMetronJobBudget, clearMetronJobBudget, createMetronCoverLookup, fetchMetronIssueRecord, metronBasicAuth, metronTransport, nextMetronQueueAt, sharedMetronLimiter } from "@/lib/covers/metron-client";
import { needsReviewNote } from "@/lib/covers/printing-cover";
import { priorLinkOf, proposalReason, REMATCH_MODE_DEFAULT, saveProposal, unmatchedPlan, type ProposalInput, type RematchMode } from "@/lib/covers/propose-match";
import { applyEnrichment, applyGcdLink } from "@/lib/covers/run";
import { MetronBudgetError, type CoverQuery, type MetronIssueHit } from "@/lib/covers/types";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import type { Prisma } from "@prisma/client";

let inflight: Promise<void> | null = null;
let finishedForProcess = false;
let nextAttemptAt = 0;
let metronClosedUntil = 0;
let gcdClosedUntil = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

const EDITION_REMATCH_LOCK = "edition-rematch.lock";
const EDITION_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function editionLockFile(dir: string): string {
  return path.join(dir, EDITION_REMATCH_LOCK);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function editionLockStale(file: string): boolean {
  try {
    const stat = statSync(file);
    const pid = Number(readFileSync(file, "utf8").split("\n")[0]);
    if (!pidAlive(pid)) return true;
    return Date.now() - stat.mtimeMs > EDITION_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

/** One pass across processes. A dead pid or a lock older than two hours can be taken. */
export function acquireEditionRematchLock(dir = coversDir()): boolean {
  mkdirSync(dir, { recursive: true });
  const file = editionLockFile(dir);
  const payload = `${process.pid}\n${Date.now()}\n`;
  try {
    writeFileSync(file, payload, { flag: "wx" });
    return true;
  } catch {
    if (!editionLockStale(file)) return false;
    try {
      unlinkSync(file);
      writeFileSync(file, payload, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export function editionRematchLockHeld(dir = coversDir()): boolean {
  const file = editionLockFile(dir);
  try {
    statSync(file);
  } catch {
    return false;
  }
  return !editionLockStale(file);
}

export function editionRematchLockOwned(dir = coversDir()): boolean {
  try {
    return readFileSync(editionLockFile(dir), "utf8").startsWith(`${process.pid}\n`);
  } catch {
    return false;
  }
}

/** Keep a long pass from looking abandoned. False when another process owns the file. */
export function refreshEditionRematchLock(dir = coversDir()): boolean {
  if (!editionRematchLockOwned(dir)) return false;
  const now = new Date();
  try {
    utimesSync(editionLockFile(dir), now, now);
    return true;
  } catch {
    return false;
  }
}

export function releaseEditionRematchLock(dir = coversDir()): void {
  if (!editionRematchLockOwned(dir)) return;
  try {
    unlinkSync(editionLockFile(dir));
  } catch {
    // The lock is already gone.
  }
}

/**
 * Run at most one edition pass. The callback writes the done marker only after its last pass.
 * A second caller gets false while the lock is held, and true when the marker is already done.
 */
export async function guardEditionPass(
  dir: string,
  already: () => Promise<boolean>,
  run: () => Promise<boolean>,
): Promise<boolean> {
  if (await already()) return true;
  if (!acquireEditionRematchLock(dir)) return false;
  try {
    if (await already()) return true;
    return await run();
  } finally {
    releaseEditionRematchLock(dir);
  }
}

export function armJobResume(waitMs: number, fire: () => void, schedule?: (ms: number, fn: () => void) => void): void {
  if (waitMs <= 0) {
    fire();
    return;
  }
  const start =
    schedule ??
    ((ms: number, fn: () => void) => {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(fn, Math.min(ms, 2_147_483_647));
    });
  start(waitMs, fire);
}

function wakeLater(resumeAt: number): void {
  nextAttemptAt = Math.max(nextAttemptAt, resumeAt);
  armJobResume(Math.max(0, resumeAt - Date.now()), () => {
    if (inflight) {
      wakeLater(Date.now() + 1_000);
      return;
    }
    nextAttemptAt = 0;
    const job = readEditionJob();
    if (job?.state === "paused" && job.resumeAt && Date.parse(job.resumeAt) <= Date.now() + 1_000) {
      writeEditionJob({ ...job, state: "running", resumeAt: null, message: "Edition re-match: running" });
    }
    scheduleFacsimileRematch();
  });
}

export function scheduleFacsimileRematch(): void {
  if (process.env.VITEST || process.env.NEXT_PHASE === "phase-production-build") return;
  if (finishedForProcess || inflight || editionRematchLockHeld()) return;
  const metronHeld = nextMetronQueueAt(Date.now());
  if (metronHeld != null && metronHeld > Date.now()) {
    wakeLater(metronHeld);
    return;
  }
  const persisted = readEditionJob();
  if (persisted?.metronResumeAt) {
    const at = Date.parse(persisted.metronResumeAt);
    if (Number.isFinite(at) && at > metronClosedUntil) metronClosedUntil = at;
  }
  let wait = Math.max(0, nextAttemptAt - Date.now());
  if (persisted?.state === "paused" && persisted.resumeAt) {
    const at = Date.parse(persisted.resumeAt);
    if (Number.isFinite(at)) wait = Math.max(wait, at - Date.now());
  }
  if (wait > 0) {
    wakeLater(Date.now() + wait);
    return;
  }
  nextAttemptAt = Date.now() + 60_000;
  inflight = runStoredFacsimileRematch()
    .then((finished) => {
      if (finished) finishedForProcess = true;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Edition re-match failed.";
      return writeLog({ level: "error", source: "covers/backfill", message });
    })
    .finally(() => {
      inflight = null;
    });
}

function catalogYear(issue: MetronIssueHit): number | null {
  const day = calendarDay(issue.storeDate);
  if (day) return Number(day.slice(0, 4));
  return issue.releaseYear ?? null;
}

function coverQuery(comic: {
  series: string;
  issueNo: string | null;
  issue: string | null;
  coverYear: number | null;
  barcode: string | null;
  variant: string | null;
  publisher: string | null;
  title?: string | null;
  fullTitle?: string | null;
  variantDescription?: string | null;
  format?: string | null;
  shelfFormat?: string | null;
  subtitle?: string | null;
  releaseYear?: number | null;
  releaseDate?: Date | null;
  seriesYear?: number | null;
  coverPrice?: unknown;
}): CoverQuery {
  return {
    series: comic.series,
    issueNo: comic.issueNo,
    issue: comic.issue,
    coverYear: comic.coverYear,
    barcode: comic.barcode,
    variant: comic.variant,
    publisher: comic.publisher,
    title: comic.title,
    fullTitle: comic.fullTitle,
    variantDescription: comic.variantDescription,
    format: comic.format,
    shelfFormat: comic.shelfFormat,
    subtitle: comic.subtitle,
    releaseYear: comic.releaseYear,
    releaseDate: comic.releaseDate,
    seriesYear: comic.seriesYear,
    coverPrice: comic.coverPrice,
  };
}

async function clearAutomaticLink(comicId: string, reason: string, options?: { keepCover?: boolean }): Promise<void> {
  const comic = await prisma.comic.findUnique({ where: { id: comicId } });
  if (!comic) return;
  const sources = readFieldSources(comic.fieldSources);
  const data: Prisma.ComicUpdateInput = {
    metronIssueId: null,
    metronSeriesId: null,
    metronIssueUrl: null,
    metronSeriesUrl: null,
    gcdIssueId: null,
    gcdSeriesId: null,
    coverNote: options?.keepCover ? needsReviewNote(reason) : reason,
    coverCheckedAt: new Date(),
    fieldSources: sources,
  };
  if (!options?.keepCover) {
    data.coverFile = null;
    data.coverUrl = null;
    data.coverStatus = "unmatched";
  }
  const writable = data as unknown as Record<string, unknown>;
  for (const field of METRON_FIELDS) {
    if (sources[field] !== "metron" && sources[field] !== "gcd") continue;
    writable[field] = null;
    delete sources[field];
  }
  data.fieldSources = sources;
  await prisma.comic.update({ where: { id: comicId }, data });
  await writeCatalogYear(comicId, null);
  await writePrintingCover(comicId, null);
}

async function closeMetron(error: MetronBudgetError): Promise<void> {
  if (metronClosedUntil > Date.now()) return;
  const pause = await recordBudgetPause("Edition re-match", error);
  metronClosedUntil = pause.resumeAt;
  const job = readEditionJob();
  writeEditionJob({
    state: "running",
    message: budgetPauseMessage("Edition re-match", pause),
    resumeAt: new Date(pause.resumeAt).toISOString(),
    metronResumeAt: new Date(pause.resumeAt).toISOString(),
    matched: job?.matched ?? 0,
    unmatched: job?.unmatched ?? 0,
  });
  wakeLater(pause.resumeAt);
}

async function noteGcdPause(error: GcdBudgetError): Promise<void> {
  const resumeAt = error.pause.resumeAt > Date.now() ? error.pause.resumeAt : Date.now() + 30_000;
  if (resumeAt <= gcdClosedUntil) return;
  gcdClosedUntil = resumeAt;
  await writeLog({
    level: "info",
    source: "gcd",
    message: "GCD is paused. Metron matching continues.",
    details: { resumeAt: new Date(resumeAt).toISOString(), budget: error.pause.budget },
  });
}

export async function rematchShelfCopy(
  comicId: string,
  options?: { metron?: boolean; mode?: RematchMode },
): Promise<{ ok: boolean; message: string; outcome: RematchOutcome; proposed: boolean; notice: string | null; limitBlocks: LimitBlock[]; searchedSources: string[] }> {
  const comic = await prisma.comic.findUnique({ where: { id: comicId } });
  const mode = options?.mode ?? REMATCH_MODE_DEFAULT;
  if (!comic) return { ok: false, message: "That issue is not on the shelf.", outcome: "unmatched", proposed: false, notice: null, limitBlocks: [], searchedSources: [] };
  const link = readManualLink(comic.manualLink);
  if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId) {
    return { ok: false, message: "This link was chosen by hand. Unlink it first.", outcome: "skipped", proposed: false, notice: null, limitBlocks: [], searchedSources: [] };
  }
  if (link.userCover) {
    return { ok: false, message: "This cover was uploaded. Unlink the catalog id if you want, and the photo stays.", outcome: "skipped", proposed: false, notice: null, limitBlocks: [], searchedSources: [] };
  }

  const query = coverQuery(comic);
  const edition = detectEdition(query);
  let reason =
    edition.kind === "facsimile"
      ? `No facsimile issue for ${comic.series} #${edition.issueNo || "?"}.`
      : edition.kind === "printing"
        ? `No later printing for ${comic.series} #${edition.issueNo || "?"}.`
        : "No confident match.";
  const metronReady = Boolean(await metronBasicAuth());
  const gcdFirst = edition.kind === "facsimile" || edition.kind === "printing";
  const keepPrintingCover = edition.kind === "printing";
  let metronSkipped = options?.metron === false || metronClosedUntil > Date.now();
  let gcdTried = false;
  const needsCredentials = !metronReady && !metronSkipped;
  const limitBlocks: LimitBlock[] = [];
  const searchedSources: string[] = [];
  const pack = (result: { ok: boolean; message: string; outcome: RematchOutcome; proposed?: boolean }) => {
    const notice = limitNotices(limitBlocks, searchedSources) || null;
    const blocked = new Set(limitBlocks.map((block) => block.source));
    const didSearch = searchedSources.some((name) => !blocked.has(name as LimitBlock["source"]));
    const proposed = result.proposed === true;
    if (notice && !didSearch && result.outcome !== "matched" && result.outcome !== "skipped") {
      return { ...result, ok: false, message: notice, proposed, notice, limitBlocks, searchedSources };
    }
    return { ...result, proposed, notice, limitBlocks, searchedSources };
  };

  const holdProposal = async (draft: Omit<ProposalInput, "comicId" | "priorLink">) => {
    const saved = await saveProposal({ ...draft, comicId, priorLink: priorLinkOf(comic) });
    if (saved === "saved") return { message: draft.reason, proposed: true };
    if (saved === "unchanged") return { message: `${comic.series} #${comic.issueNo || "?"} is already linked to ${draft.provider} ${draft.issueId}.`, proposed: false };
    return { message: `${comic.series} #${comic.issueNo || "?"}: that ${draft.provider} issue was already reviewed.`, proposed: false };
  };

  const linkGcd = async (): Promise<{ ok: true; held: { message: string; proposed: boolean } } | { ok: false; reason: string }> => {
    if (Date.now() < gcdClosedUntil) return { ok: false, reason: "GCD is paused. Metron matching continues." };
    searchedSources.push("GCD");
    let gcd;
    try {
      gcd = await resolveGcdCover(query, createGcdCatalog());
    } catch (error) {
      if (error instanceof GcdBudgetError) {
        const block = limitBlockFromError(error);
        if (block) limitBlocks.push(block);
        await noteGcdPause(error);
        return { ok: false, reason: "GCD is paused. Metron matching continues." };
      }
      throw error;
    }
    if (gcd.status !== "matched") return { ok: false, reason: gcd.reason };
    try {
      const issue = await createGcdCatalog().issue(gcd.issue.id);
      if (mode === "propose") {
        const held = await holdProposal({
          provider: "gcd",
          issueId: gcd.issue.id,
          seriesId: gcd.issue.seriesId,
          confidence: gcd.score,
          reason: proposalReason("gcd", gcd.issue.seriesName, gcd.issue.number, gcd.issue.id, gcd.score, gcd.coverReview),
          coverUrl: issue?.coverUrl ?? gcd.issue.imageUrl,
          title: gcd.issue.seriesName,
          issueNo: gcd.issue.number,
          variant: issue?.variant ?? gcd.issue.variant ?? null,
        });
        if (held.proposed) {
          await writeLog({ level: "info", source: "covers/backfill", message: held.message, details: { comicId, gcdIssueId: gcd.issue.id, score: gcd.score, proposed: true } });
        }
        return { ok: true, held };
      }
      const { gcdDetails } = await import("@/lib/covers/gcd-match");
      const detail = issue ? gcdDetails(issue) : null;
      await clearAutomaticLink(comicId, "Re-matching.", { keepCover: keepPrintingCover });
      const confirmedPrinting = edition.kind === "printing" && edition.printing != null && !gcd.coverReview;
      await applyGcdLink(comicId, gcd.issue.id, gcd.issue.seriesId, gcd.score, detail, {
        coverReview: gcd.coverReview ?? null,
        printing: edition.kind === "printing" ? (confirmedPrinting ? edition.printing : null) : undefined,
      });
      await writeCatalogYear(comicId, catalogYear(gcd.issue));
      const review = gcd.coverReview ? ` ${needsReviewNote(gcd.coverReview)}` : "";
      const message = `Matched GCD ${gcd.issue.id} (${gcd.issue.seriesName} #${gcd.issue.number}), score ${gcd.score}.${review}`;
      await writeLog({ level: "info", source: "covers/backfill", message, details: { comicId, gcdIssueId: gcd.issue.id, score: gcd.score } });
      return { ok: true, held: { message, proposed: false } };
    } catch (error) {
      if (error instanceof GcdBudgetError) {
        const block = limitBlockFromError(error);
        if (block) limitBlocks.push(block);
        await noteGcdPause(error);
        return { ok: false, reason: "GCD is paused. Metron matching continues." };
      }
      throw error;
    }
  };

  const finish = async (held: { message: string; proposed: boolean } | null) => {
    if (held) return pack({ ok: true, message: held.message, outcome: held.proposed ? "matched" : "skipped", proposed: held.proposed });
    const outcome = editionOutcome({ matched: false, metronSkipped, gcdTried });
    if (outcome === "unmatched" && unmatchedPlan(mode) === "leave") {
      return pack({ ok: true, message: reason, outcome, proposed: false });
    }
    if (outcome === "unmatched") {
      if (keepPrintingCover) {
        await prisma.comic.update({
          where: { id: comicId },
          data: { coverNote: needsReviewNote(reason), coverCheckedAt: new Date() },
        });
      } else {
        await clearAutomaticLink(comicId, reason);
      }
      await writeLog({ level: "info", source: "covers/backfill", message: reason, details: { comicId } });
      return pack({ ok: true, message: reason, outcome });
    }
    return pack({ ok: false, message: reason, outcome });
  };

  try {
    if (gcdFirst) {
      gcdTried = true;
      const gcd = await linkGcd();
      if (gcd.ok) return finish(gcd.held);
      reason = gcd.reason || reason;
    }

    if (!metronSkipped && metronReady) {
      searchedSources.push("Metron");
      try {
        const transport = await metronTransport();
        const decision = await resolveCover(query, createMetronCoverLookup(transport));
        if (decision.status === "matched" && mode === "propose") {
          const held = await holdProposal({
            provider: "metron",
            issueId: decision.issue.id,
            seriesId: decision.issue.seriesId,
            confidence: decision.score,
            reason: proposalReason("metron", decision.issue.seriesName, decision.issue.number, decision.issue.id, decision.score, decision.coverReview),
            coverUrl: decision.issue.imageUrl,
            title: decision.issue.seriesName,
            issueNo: decision.issue.number,
            variant: decision.issue.variant ?? null,
          });
          if (held.proposed) {
            await writeLog({ level: "info", source: "covers/backfill", message: held.message, details: { comicId, metronIssueId: decision.issue.id, score: decision.score, proposed: true } });
          }
          return finish(held);
        }
        if (decision.status === "matched") {
          const detail = await fetchMetronIssueRecord(transport, decision.issue.id);
          const printing = savedPrintingCover(query, decision.issue, detail?.covers);
          let filename: string | null = null;
          let note = printing.active ? printing.note : null;
          const imageUrl = printing.active ? printing.imageUrl : detail?.imageUrl || decision.issue.imageUrl;
          if (imageUrl) {
            try {
              filename = await downloadCover(imageUrl, decision.issue.id, coversDir());
            } catch (error) {
              if (error instanceof MetronBudgetError) throw error;
              filename = null;
              if (printing.active) note = error instanceof Error ? error.message : "Could not download the printing cover.";
            }
          }
          const keep = keepPrintingCover && !filename;
          const yearReview = !printing.active && decision.coverReview ? needsReviewNote(decision.coverReview) : null;
          await clearAutomaticLink(comicId, "Re-matching.", { keepCover: keep });
          await applyEnrichment(comicId, detail, {
            metronIssueId: decision.issue.id,
            metronSeriesId: decision.issue.seriesId,
            ...(filename
              ? { coverFile: filename, coverUrl: coverPublicPath(filename), coverStatus: "matched", coverNote: yearReview }
              : keep
                ? { coverNote: needsReviewNote(note), coverStatus: comic.coverFile ? comic.coverStatus : null }
                : { coverFile: null, coverUrl: null, coverStatus: null, coverNote: yearReview ?? note }),
            coverCheckedAt: new Date(),
          });
          const year = catalogYear(decision.issue) ?? (detail?.releaseDate ? detail.releaseDate.getUTCFullYear() : null);
          await writeCatalogYear(comicId, year);
          if (printing.active) await writePrintingCover(comicId, filename ? printing.printing : null);
          const review = yearReview ? ` ${yearReview}` : filename ? "" : note ? ` ${needsReviewNote(note)}` : "";
          const message = `Matched Metron ${decision.issue.id} (${decision.issue.seriesName} #${decision.issue.number}), score ${decision.score}.${review}`;
          await writeLog({ level: "info", source: "covers/backfill", message, details: { comicId, metronIssueId: decision.issue.id, score: decision.score } });
          return finish({ message, proposed: false });
        }
        reason = decision.reason;
      } catch (error) {
        if (!(error instanceof MetronBudgetError)) throw error;
        const block = limitBlockFromError(error, sharedMetronLimiter().snapshot());
        if (block) limitBlocks.push(block);
        await closeMetron(error);
        metronSkipped = true;
      }
    }

    if (!gcdFirst && !gcdTried) {
      gcdTried = true;
      const gcd = await linkGcd();
      if (gcd.ok) return finish(gcd.held);
      reason = gcd.reason || reason;
    }
  } catch (error) {
    if (error instanceof GcdBudgetError) {
      await noteGcdPause(error);
      reason = "GCD is paused. Metron matching continues.";
      return finish(null);
    }
    throw error;
  }

  if (needsCredentials) {
    return pack({ ok: false, message: "Set a Metron API token, or a username and password, in Settings or the environment.", outcome: "unmatched" });
  }
  return finish(null);
}

const linkedSelect = {
  id: true,
  series: true,
  issueNo: true,
  issue: true,
  title: true,
  fullTitle: true,
  variant: true,
  variantDescription: true,
  format: true,
  shelfFormat: true,
  subtitle: true,
  publisher: true,
  coverYear: true,
  releaseYear: true,
  releaseDate: true,
  seriesYear: true,
  coverPrice: true,
  barcode: true,
  metronIssueId: true,
  gcdIssueId: true,
  manualLink: true,
} as const;

export async function rematchAllSuspectCopies(options?: { mode?: RematchMode }): Promise<{ ok: boolean; message: string; notice: string | null; queueItems: QueueSeed[] }> {
  armMetronJobBudget();
  try {
    return await rematchAllSuspectCopiesBody(options?.mode ?? REMATCH_MODE_DEFAULT);
  } finally {
    clearMetronJobBudget();
  }
}

function queueSeed(comicId: string, blocks: LimitBlock[]): QueueSeed | null {
  const hint = hintFromBlocks("metron", blocks, "relink");
  if (!hint) return null;
  return { comicId, source: hint.source, resumeAt: hint.resumeAt, kind: hint.kind };
}

async function rematchAllSuspectCopiesBody(mode: RematchMode): Promise<{ ok: boolean; message: string; notice: string | null; queueItems: QueueSeed[] }> {
  const [comics, years, printings] = await Promise.all([
    prisma.comic.findMany({
      where: { OR: [{ metronIssueId: { not: null } }, { gcdIssueId: { not: null } }] },
      select: linkedSelect,
    }),
    readCatalogYears(),
    readPrintingCovers(),
  ]);
  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  let metron = metronClosedUntil <= Date.now();
  const limitBlocks: LimitBlock[] = [];
  const searchedSources: string[] = [];
  const queueItems: QueueSeed[] = [];
  for (const comic of comics) {
    const reason = suspectMatchReason({ ...comic, catalogStoreYear: years[comic.id] ?? null, catalogPrinting: printings[comic.id] ?? null });
    if (!reason) continue;
    const link = readManualLink(comic.manualLink);
    if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId || link.userCover) {
      skipped += 1;
      continue;
    }
    try {
      const result = await rematchShelfCopy(comic.id, { metron, mode });
      limitBlocks.push(...result.limitBlocks);
      searchedSources.push(...result.searchedSources);
      if (result.outcome !== "matched" && result.outcome !== "skipped") {
        const seed = queueSeed(comic.id, result.limitBlocks);
        if (seed) queueItems.push(seed);
      }
      if (result.outcome === "deferred" || result.outcome === "metron-budget") {
        metron = false;
        unmatched += 1;
        continue;
      }
      if (result.outcome === "matched") matched += 1;
      else if (result.outcome === "skipped") skipped += 1;
      else unmatched += 1;
    } catch (error) {
      if (error instanceof MetronBudgetError) {
        const block = limitBlockFromError(error, sharedMetronLimiter().snapshot());
        if (block) {
          limitBlocks.push(block);
          const seed = queueSeed(comic.id, [block]);
          if (seed) queueItems.push(seed);
        }
        metron = false;
        continue;
      }
      if (error instanceof GcdBudgetError) {
        const block = limitBlockFromError(error);
        if (block) {
          limitBlocks.push(block);
          const seed = queueSeed(comic.id, [block]);
          if (seed) queueItems.push(seed);
        }
        await noteGcdPause(error);
        unmatched += 1;
        continue;
      }
      unmatched += 1;
    }
  }
  const message =
    mode === "propose"
      ? `Proposed ${matched}. Left ${unmatched} unmatched. Skipped ${skipped} hand-picked links.`
      : `Re-matched ${matched}. Left ${unmatched} unmatched. Skipped ${skipped} hand-picked links.`;
  const notice = limitNotices(limitBlocks, searchedSources) || null;
  await writeLog({ level: "info", source: "covers/backfill", message: notice ? `${message} ${notice}` : message, details: { matched, unmatched, skipped } });
  return { ok: true, message, notice, queueItems };
}

async function rematchAlreadyDone(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: FACSIMILE_REMATCH_KEY } });
  return row?.plain === "done";
}

async function runStoredFacsimileRematch(): Promise<boolean> {
  return runInLane("background", async () => {
  if (await rematchAlreadyDone()) return true;
  if (!(await metronBasicAuth())) return false;
  return guardEditionPass(coversDir(), rematchAlreadyDone, async () => {
    armMetronJobBudget();
    try {
      return await runStoredFacsimileRematchBody();
    } finally {
      clearMetronJobBudget();
    }
  });
  });
}

async function runStoredFacsimileRematchBody(): Promise<boolean> {
  const existing = readEditionJob();
  writeEditionJob({
    state: "running",
    message: "Edition re-match: running",
    resumeAt: null,
    metronResumeAt: existing?.metronResumeAt && Date.parse(existing.metronResumeAt) > Date.now() ? existing.metronResumeAt : null,
    matched: 0,
    unmatched: 0,
  });
  const summary = await runFacsimilePass({
    already: rematchAlreadyDone,
    markDone: async () => {
      if (!editionRematchLockOwned()) return;
      await prisma.appSetting.upsert({
        where: { key: FACSIMILE_REMATCH_KEY },
        create: { key: FACSIMILE_REMATCH_KEY, plain: "done", secret: null },
        update: { plain: "done", secret: null },
      });
    },
    ids: async () => {
      const [comics, years, printings] = await Promise.all([
        prisma.comic.findMany({
          where: { OR: [{ metronIssueId: { not: null } }, { gcdIssueId: { not: null } }] },
          select: linkedSelect,
        }),
        readCatalogYears(),
        readPrintingCovers(),
      ]);
      return comics.flatMap((comic) => {
        const reason = suspectMatchReason({ ...comic, catalogStoreYear: years[comic.id] ?? null, catalogPrinting: printings[comic.id] ?? null });
        if (!reason) return [];
        const link = readManualLink(comic.manualLink);
        const manual = Boolean(link.metronIssueId || link.gcdIssueId || link.comicvineIssueId || link.userCover);
        return [{ id: comic.id, manual }];
      });
    },
    rematch: async (id, ctx) => {
      if (!refreshEditionRematchLock()) return "stopped";
      try {
        const result = await rematchShelfCopy(id, { metron: ctx?.metron !== false });
        return result.outcome;
      } catch (error) {
        if (error instanceof MetronBudgetError) {
          await closeMetron(error);
          return "deferred";
        }
        if (error instanceof GcdBudgetError) {
          await noteGcdPause(error);
          return "unmatched";
        }
        await writeLog({
          level: "warn",
          source: "covers/backfill",
          message: error instanceof Error ? error.message : "Facsimile re-match failed.",
          details: { comicId: id },
        });
        return "unmatched";
      }
    },
  });
  if (!editionRematchLockOwned()) return false;
  if (summary.done) {
    writeEditionJob({
      state: "finished",
      message: "Edition re-match: finished",
      resumeAt: null,
      metronResumeAt: null,
      matched: summary.matched,
      unmatched: summary.unmatched,
    });
    if (summary.matched > 0 || summary.unmatched > 0 || summary.skipped > 0) {
      await writeLog({
        level: "info",
        source: "covers/backfill",
        message: `Edition re-match finished. Proposed ${summary.matched}. Unmatched ${summary.unmatched}. Skipped ${summary.skipped} hand-picked links.`,
        details: summary,
      });
    }
  } else {
    const job = readEditionJob();
    const resumeAt = job?.resumeAt ?? (metronClosedUntil > Date.now() ? new Date(metronClosedUntil).toISOString() : null);
    writeEditionJob({
      state: "paused",
      message: job?.message ?? "Edition re-match: paused",
      resumeAt,
      metronResumeAt: job?.metronResumeAt ?? (metronClosedUntil > Date.now() ? new Date(metronClosedUntil).toISOString() : null),
      matched: summary.matched,
      unmatched: summary.unmatched,
    });
  }
  return summary.done;
}
