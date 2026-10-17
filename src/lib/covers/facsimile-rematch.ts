import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGcdCatalog, GcdBudgetError } from "@/lib/catalog/gcd";
import { limitBlockFromError, limitNotices, type LimitBlock } from "@/lib/catalog/limit-notice";
import { hintFromBlocks, type QueueSeed } from "@/lib/catalog/search-queue";
import { runInLane } from "@/lib/catalog/rate-lane";
import { coverPublicPath } from "@/lib/covers/backfill";
import { budgetPauseMessage, recordBudgetPause } from "@/lib/covers/budget-pause";
import { calendarDay, detectEdition, includeInRematch, rematchRunPlan, suspectMatchReason, type RematchScope } from "@/lib/covers/edition";
import {
  addMiss,
  armEditionPause,
  comicAttemptSkipMessage,
  continuedRunId,
  EDITION_PAUSE_HANG_MESSAGE,
  EDITION_STALE_MESSAGE,
  editionPauseOverdue,
  editionRunBlocks,
  editionRunStale,
  nextResumeWake,
  noteComicAttempt,
  resumeRematchIndex,
  type EditionJobState,
} from "@/lib/covers/edition-job";
import { followPausedEditionJob, type ResumeSweepResult } from "@/lib/covers/edition-resume";
import { METRON_FIELDS, readFieldSources } from "@/lib/covers/enrich";
import { editionOutcome, runFacsimilePass, type RematchOutcome } from "@/lib/covers/facsimile-once";
import { FACSIMILE_REMATCH_KEY, readCatalogYears, readPrintingCovers, writeCatalogYear, writePrintingCover } from "@/lib/covers/facsimile-years";
import { coversDir, downloadCover } from "@/lib/covers/files";
import { resolveGcdCover } from "@/lib/covers/gcd-match";
import { deleteEditionJob, readEditionJob, writeEditionJob, type EditionJobWrite } from "@/lib/covers/job-state";
import { resolveCover, savedPrintingCover } from "@/lib/covers/match";
import { armFullRunCap, armMetronJobBudget, clearFullRunCap, clearMetronJobBudget, createMetronCoverLookup, fetchMetronIssueRecord, fullRunMetronUsed, metronBasicAuth, metronTransport, nextMetronQueueAt, sharedMetronLimiter } from "@/lib/covers/metron-client";
import { needsReviewNote } from "@/lib/covers/printing-cover";
import { priorLinkOf, priorProposalBlocked, proposalBlocked, proposalReason, REMATCH_MODE_DEFAULT, saveProposal, supersedeManualProposals, unmatchedPlan, type ProposalInput, type RematchMode } from "@/lib/covers/propose-match";
import { applyEnrichment, applyGcdLink } from "@/lib/covers/run";
import { MetronBudgetError, type CoverQuery, type MetronIssueHit } from "@/lib/covers/types";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import type { Prisma } from "@prisma/client";

const processState = globalThis as typeof globalThis & {
  longboxEditionInflight?: Promise<void> | null;
};

function editionInflight(): Promise<void> | null {
  return processState.longboxEditionInflight ?? null;
}

function setEditionInflight(next: Promise<void> | null): void {
  processState.longboxEditionInflight = next;
}

let finishedForProcess = false;
let nextAttemptAt = 0;
let metronClosedUntil = 0;
let gcdClosedUntil = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let resumePostponedFrom: number | null = null;
let pauseRequested = false;

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
    const job = readEditionJob(path.dirname(file));
    if (job && (editionRunStale(job) || job.state === "stale" || job.state === "error")) return true;
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

function cancelResumeTimer(): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  resumePostponedFrom = null;
  nextAttemptAt = 0;
}

function writeJob(patch: Partial<EditionJobState> & { state: EditionJobState["state"] }, dir = coversDir()): EditionJobState {
  const job = readEditionJob(dir);
  const live = fullRunMetronUsed();
  const liveMetron = live.day
    ? { calls: live.used, day: live.day }
    : { calls: job?.metronCalls ?? 0, day: job?.metronDay ?? null };
  const next: EditionJobWrite = {
    state: patch.state,
    message: patch.message === undefined ? (job?.message ?? null) : patch.message,
    resumeAt: patch.resumeAt === undefined ? (job?.resumeAt ?? null) : patch.resumeAt,
    metronResumeAt: patch.metronResumeAt === undefined ? (job?.metronResumeAt ?? null) : patch.metronResumeAt,
    matched: patch.matched ?? job?.matched ?? 0,
    unmatched: patch.unmatched ?? job?.unmatched ?? 0,
    attempted: patch.attempted ?? job?.attempted ?? 0,
    proposed: patch.proposed ?? job?.proposed ?? 0,
    noCandidate: patch.noCandidate ?? job?.noCandidate ?? 0,
    skipped: patch.skipped ?? job?.skipped ?? 0,
    cursorId: patch.cursorId === undefined ? (job?.cursorId ?? null) : patch.cursorId,
    cursorAt: patch.cursorAt === undefined ? (job?.cursorAt ?? null) : patch.cursorAt,
    cursorSettled: patch.cursorSettled === undefined ? (job?.cursorSettled ?? false) : patch.cursorSettled,
    attempts: patch.attempts ?? job?.attempts ?? {},
    heartbeatAt: patch.heartbeatAt === undefined ? (job?.heartbeatAt ?? null) : patch.heartbeatAt,
    runId: patch.runId === undefined ? (job?.runId ?? null) : patch.runId,
    mode: patch.mode === undefined ? (job?.mode ?? null) : patch.mode,
    scope: patch.scope === undefined ? (job?.scope ?? "suspect") : patch.scope,
    misses: patch.misses ?? job?.misses ?? {},
    metronCalls: patch.metronCalls ?? liveMetron.calls,
    metronDay: patch.metronDay === undefined ? liveMetron.day : patch.metronDay,
    updatedAt: patch.updatedAt,
  };
  return writeEditionJob(next, dir);
}

function failEditionJob(message: string): void {
  writeJob({ state: "error", message, resumeAt: null, runId: null });
  void writeLog({ level: "error", source: "covers/backfill", message });
}

function markEditionStale(message = EDITION_STALE_MESSAGE): void {
  const job = readEditionJob();
  if (!job || job.state === "stale") return;
  writeJob({ state: "stale", message, resumeAt: null, runId: null });
  void writeLog({ level: "error", source: "covers/backfill", message });
}

/** Persist a stale running job, or a pause that never resumed, so the next page load shows it. */
export function noteStaleEditionJob(): EditionJobState | null {
  const job = readEditionJob();
  if (!job) return null;
  if (editionRunStale(job)) {
    markEditionStale();
    return readEditionJob();
  }
  if (editionPauseOverdue(job) && !editionInflight()) {
    markEditionStale(EDITION_PAUSE_HANG_MESSAGE);
    return readEditionJob();
  }
  return job;
}

export const EDITION_RESUME_SWEEP_MS = 5_000;
const globalResume = globalThis as typeof globalThis & { longboxEditionResumeSweep?: ReturnType<typeof setInterval> };
let editionResumeStart: (() => boolean) | null = null;

/** Tests replace the pass starter. Production starts the real re-match. */
export function setEditionResumeStartForTests(start: (() => boolean) | null): void {
  editionResumeStart = start;
}

export function stopEditionResumeSweep(): void {
  if (globalResume.longboxEditionResumeSweep) clearInterval(globalResume.longboxEditionResumeSweep);
  globalResume.longboxEditionResumeSweep = undefined;
  editionResumeStart = null;
  setEditionInflight(null);
}

function beginDueEditionResume(): boolean {
  if (editionResumeStart) {
    const started = editionResumeStart();
    if (started && !editionInflight()) setEditionInflight(Promise.resolve());
    return started;
  }
  const before = editionInflight();
  scheduleFacsimileRematch();
  const after = editionInflight();
  return Boolean(after) && after !== before;
}

/**
 * Read the persisted pause and start it once resumeAt has passed.
 * The interval that calls this is armed at process boot, outside any request.
 */
export function sweepEditionResume(now = Date.now()): ResumeSweepResult {
  return followPausedEditionJob({
    job: readEditionJob(),
    now,
    inflight: Boolean(editionInflight()),
    start: beginDueEditionResume,
    markStale: () => {
      const current = readEditionJob();
      markEditionStale(current?.state === "paused" ? EDITION_PAUSE_HANG_MESSAGE : EDITION_STALE_MESSAGE);
    },
    fail: (message) => failEditionJob(message),
    readJob: () => readEditionJob(),
  });
}

/** One sweep for this process. A server action's setTimeout is not the resume clock. */
export function armEditionResumeSweep(options?: { force?: boolean }): void {
  if (!options?.force && (process.env.VITEST === "true" || process.env.NEXT_PHASE === "phase-production-build")) return;
  if (globalResume.longboxEditionResumeSweep) return;
  const timer = setInterval(() => {
    try {
      sweepEditionResume();
    } catch (error) {
      failEditionJob(error instanceof Error ? error.message : "Edition re-match resume sweep failed.");
    }
  }, EDITION_RESUME_SWEEP_MS);
  timer.unref?.();
  globalResume.longboxEditionResumeSweep = timer;
}

function wakeLater(resumeAt: number): void {
  nextAttemptAt = Math.max(nextAttemptAt, resumeAt);
  const armed = armEditionPause({
    now: Date.now(),
    resumeAt,
    schedule: (ms, fire) => armJobResume(ms, fire),
    onResume: () => {
      const job = readEditionJob();
      if (!job) return;
      const wake = nextResumeWake({
        inflight: Boolean(editionInflight()),
        resumeAt,
        now: Date.now(),
        postponedFrom: resumePostponedFrom,
      });
      if (wake.kind === "again") {
        if (editionInflight() && resumePostponedFrom == null) resumePostponedFrom = resumeAt;
        wakeLater(wake.at);
        return;
      }
      resumePostponedFrom = null;
      nextAttemptAt = 0;
      if (wake.kind === "stale") {
        markEditionStale();
        return;
      }
      if (wake.kind === "error") {
        failEditionJob(wake.message);
        return;
      }
      try {
        scheduleFacsimileRematch();
      } catch (error) {
        failEditionJob(error instanceof Error ? error.message : "Edition re-match resume failed.");
      }
    },
  });
  if (!armed.ok) failEditionJob(armed.message);
}

function beginScheduledPass(run: () => Promise<boolean>): void {
  nextAttemptAt = Date.now() + 60_000;
  let settle: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  setEditionInflight(gate);
  void run()
    .then((finished) => {
      if (finished) finishedForProcess = true;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Edition re-match failed.";
      failEditionJob(message);
    })
    .finally(() => {
      if (editionInflight() === gate) setEditionInflight(null);
      settle();
    });
}

export function scheduleFacsimileRematch(): void {
  if (process.env.VITEST || process.env.NEXT_PHASE === "phase-production-build") return;
  if (finishedForProcess || editionInflight()) return;
  const persisted = noteStaleEditionJob();
  if (persisted?.state === "error" || persisted?.state === "stale" || persisted?.state === "finished") return;
  if (persisted?.metronResumeAt) {
    const at = Date.parse(persisted.metronResumeAt);
    if (Number.isFinite(at) && at > metronClosedUntil) metronClosedUntil = at;
  }
  const resumeAt = persisted?.resumeAt ? Date.parse(persisted.resumeAt) : Number.NaN;
  const waiting = persisted?.state === "paused" || (persisted?.state === "running" && Number.isFinite(resumeAt));
  if (waiting && Number.isFinite(resumeAt) && resumeAt > Date.now()) {
    wakeLater(resumeAt);
    return;
  }
  if (editionRematchLockHeld() && editionRunBlocks(persisted)) return;
  const metronHeld = nextMetronQueueAt(Date.now());
  if (metronHeld != null && metronHeld > Date.now()) {
    const waitingJob = readEditionJob();
    const written = waitingJob?.resumeAt ? Date.parse(waitingJob.resumeAt) : 0;
    if (waitingJob && (waitingJob.state === "paused" || waitingJob.state === "running") && metronHeld > written) {
      const resumeAt = new Date(metronHeld).toISOString();
      writeJob({
        state: "paused",
        resumeAt,
        metronResumeAt: resumeAt,
        message: waitingJob.message,
      });
    }
    wakeLater(metronHeld);
    return;
  }
  const wait = Math.max(0, nextAttemptAt - Date.now());
  if (wait > 0 && !waiting) {
    wakeLater(Date.now() + wait);
    return;
  }
  if (persisted?.mode === "apply") {
    beginScheduledPass(runStoredFacsimileRematch);
    return;
  }
  if (persisted?.mode === "propose" || waiting) {
    beginScheduledPass(async () => {
      await rematchAllSuspectCopies({ mode: "propose", resume: true, scope: persisted?.scope === "full" ? "full" : "suspect" });
      return false;
    });
    return;
  }
  beginScheduledPass(runStoredFacsimileRematch);
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
  pauseRequested = true;
  if (metronClosedUntil > Date.now()) {
    if (!resumeTimer && !editionInflight()) wakeLater(metronClosedUntil);
    return;
  }
  const pause = await recordBudgetPause("Edition re-match", error);
  metronClosedUntil = pause.resumeAt;
  const resumeAt = new Date(pause.resumeAt).toISOString();
  writeJob({
    state: "paused",
    message: budgetPauseMessage("Edition re-match", pause),
    resumeAt,
    metronResumeAt: resumeAt,
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
  const blocked = proposalBlocked(comic.manualLink, comic.fieldSources);
  if (blocked) {
    const message = blocked.includes("uploaded")
      ? "This cover was uploaded. Unlink the catalog id if you want, and the photo stays."
      : "This link was chosen by hand. Unlink it first.";
    return { ok: false, message, outcome: "skipped", proposed: false, notice: null, limitBlocks: [], searchedSources: [] };
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
    const priorLink = priorLinkOf(comic);
    const heldBack = priorProposalBlocked(priorLink);
    if (heldBack) return { message: heldBack, proposed: false };
    const saved = await saveProposal({ ...draft, comicId, priorLink });
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
  fieldSources: true,
} as const;

export async function rematchAllSuspectCopies(options?: { mode?: RematchMode; resume?: boolean; scope?: RematchScope }): Promise<{ ok: boolean; message: string; notice: string | null; queueItems: QueueSeed[] }> {
  return runInLane("background", async () => {
    const existing = noteStaleEditionJob();
    if (!options?.resume && (editionInflight() || (existing && editionRunBlocks(existing) && editionRematchLockHeld()))) {
      return { ok: false, message: "A re-match is already running.", notice: null, queueItems: [] };
    }
    const plan = rematchRunPlan({
      requested: options?.scope,
      resume: options?.resume,
      existing: existing ? { state: existing.state, scope: existing.scope } : null,
    });
    const owned = !editionInflight();
    const run = (async () => {
      armMetronJobBudget();
      try {
        return await rematchAllSuspectCopiesBody(options?.mode ?? REMATCH_MODE_DEFAULT, plan.resume, plan.scope);
      } finally {
        clearMetronJobBudget();
      }
    })();
    if (owned) setEditionInflight(run.then(() => undefined, () => undefined));
    try {
      return await run;
    } finally {
      if (owned) setEditionInflight(null);
    }
  });
}

export async function resumeEditionRematch(): Promise<{ ok: boolean; message: string }> {
  const job = noteStaleEditionJob();
  if (job && editionRunBlocks(job) && (editionInflight() || editionRematchLockHeld())) {
    return { ok: false, message: "A re-match is already running." };
  }
  const result = await rematchAllSuspectCopies({ mode: job?.mode === "apply" ? "apply" : "propose", resume: true });
  return { ok: result.ok, message: result.message };
}

export async function clearEditionRematch(): Promise<{ ok: boolean; message: string }> {
  cancelResumeTimer();
  pauseRequested = false;
  deleteEditionJob();
  try {
    unlinkSync(editionLockFile(coversDir()));
  } catch {
    // The lock is already gone.
  }
  await writeLog({ level: "info", source: "covers/backfill", message: "Edition re-match cleared." });
  return { ok: true, message: "Re-match cleared. The next run starts from the beginning." };
}

function queueSeed(comicId: string, blocks: LimitBlock[]): QueueSeed | null {
  const hint = hintFromBlocks("metron", blocks, "relink");
  if (!hint) return null;
  return { comicId, source: hint.source, resumeAt: hint.resumeAt, kind: hint.kind };
}

function summaryLine(input: { attempted: number; proposed: number; noCandidate: number; misses: EditionJobState["misses"] }, finished: boolean): string {
  const misses = Object.entries(input.misses)
    .filter((entry) => entry[1] > 0)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  const head = finished ? "Edition re-match finished." : "Edition re-match paused.";
  const base = `${head} Attempted ${input.attempted}. Proposed ${input.proposed}. No candidate ${input.noCandidate}.`;
  return misses ? `${base} Misses: ${misses}.` : base;
}

async function rematchAllSuspectCopiesBody(mode: RematchMode, resume: boolean, scope: RematchScope): Promise<{ ok: boolean; message: string; notice: string | null; queueItems: QueueSeed[] }> {
  const previous = resume ? readEditionJob() : null;
  const runId = continuedRunId(resume, previous?.runId, () => randomBytes(8).toString("hex"));
  let attempted = previous?.attempted ?? 0;
  let proposed = previous?.proposed ?? 0;
  let noCandidate = previous?.noCandidate ?? 0;
  let skipped = previous?.skipped ?? 0;
  let misses = { ...(previous?.misses ?? {}) };
  let cursorId = previous?.cursorId ?? null;
  let cursorAt = previous?.cursorAt ?? null;
  let cursorSettled = previous?.cursorSettled ?? false;
  let attempts = { ...(previous?.attempts ?? {}) };
  pauseRequested = false;
  if (!acquireEditionRematchLock()) {
    return { ok: false, message: "A re-match is already running.", notice: null, queueItems: [] };
  }
  const counts = () => ({
    attempted,
    proposed,
    noCandidate,
    skipped,
    misses,
    matched: proposed,
    unmatched: noCandidate,
    cursorId,
    cursorAt,
    cursorSettled,
    attempts,
    runId,
    mode,
    scope,
  });
  let started = false;
  const beat = (state: EditionJobState["state"], message: string | null, resumeAt: string | null) => {
    const current = readEditionJob();
    if (started && current?.runId !== runId) return false;
    writeJob({ state, message, resumeAt, heartbeatAt: cursorAt, ...counts() });
    started = true;
    refreshEditionRematchLock();
    return readEditionJob()?.runId === runId;
  };
  const placeCursor = (id: string) => {
    if (cursorId !== id) cursorAt = new Date().toISOString();
    cursorId = id;
    cursorSettled = false;
  };
  try {
    if (scope === "full") armFullRunCap({ used: previous?.metronCalls ?? 0, day: previous?.metronDay ?? "" });
    if (!beat("running", "Edition re-match: running", null)) {
      return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems: [] };
    }
    await supersedeManualProposals();
    const [comics, years, printings] = await Promise.all([
      prisma.comic.findMany({
        ...(scope === "full" ? {} : { where: { OR: [{ metronIssueId: { not: null } }, { gcdIssueId: { not: null } }] } }),
        select: linkedSelect,
        orderBy: { id: "asc" },
      }),
      readCatalogYears(),
      readPrintingCovers(),
    ]);
    const suspects = comics.filter((comic) => {
      const reason = suspectMatchReason({ ...comic, catalogStoreYear: years[comic.id] ?? null, catalogPrinting: printings[comic.id] ?? null });
      const manual = Boolean(proposalBlocked(comic.manualLink, comic.fieldSources));
      return includeInRematch({ scope, manual, suspect: Boolean(reason) });
    });
    const cursorIndex = previous?.cursorId ? suspects.findIndex((comic) => comic.id === previous.cursorId) : -1;
    if (previous?.cursorId && cursorIndex < 0) {
      attempted = 0;
      proposed = 0;
      noCandidate = 0;
      skipped = 0;
      misses = {};
      attempts = {};
      cursorId = null;
      cursorAt = null;
      cursorSettled = false;
    }
    const start = resumeRematchIndex(
      suspects.map((comic) => comic.id),
      cursorId,
      attempts,
      cursorSettled,
    );
    const rows = start < 0 ? suspects : suspects.slice(start);
    let metron = metronClosedUntil <= Date.now();
    const limitBlocks: LimitBlock[] = [];
    const searchedSources: string[] = [];
    const queueItems: QueueSeed[] = [];
    for (const comic of rows) {
      if (pauseRequested) break;
      if (readEditionJob()?.runId !== runId) {
        return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
      }
      const noted = noteComicAttempt(attempts, comic.id);
      attempts = noted.attempts;
      placeCursor(comic.id);
      attempted += 1;
      if (noted.skip) {
        skipped += 1;
        cursorSettled = true;
        const message = comicAttemptSkipMessage(comic.series, comic.issueNo ?? comic.issue);
        await writeLog({ level: "warn", source: "covers/backfill", message, details: { comicId: comic.id, runId, attempts: noted.count } });
        if (!beat("running", "Edition re-match: running", null)) {
          return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
        }
        continue;
      }
      if (!beat("running", "Edition re-match: running", null)) {
        return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
      }
      if (proposalBlocked(comic.manualLink, comic.fieldSources)) {
        skipped += 1;
        cursorSettled = true;
        if (!beat("running", "Edition re-match: running", null)) {
          return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
        }
        continue;
      }
      try {
        const result = await rematchShelfCopy(comic.id, { metron, mode });
        limitBlocks.push(...result.limitBlocks);
        searchedSources.push(...result.searchedSources);
        if (pauseRequested || result.outcome === "deferred" || result.outcome === "metron-budget") {
          metron = false;
          const job = readEditionJob();
          if (job?.state === "error") {
            return { ok: false, message: job.message ?? "Edition re-match resume failed.", notice: null, queueItems };
          }
          const resumeAt = job?.resumeAt ?? new Date(Date.now() + 1_000).toISOString();
          const message = job?.state === "paused" && job.message ? job.message : "Edition re-match paused. It will resume.";
          if (!beat("paused", message, resumeAt)) {
            return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
          }
          const at = Date.parse(resumeAt);
          if (!resumeTimer) wakeLater(Number.isFinite(at) ? at : Date.now() + 1_000);
          return { ok: true, message, notice: limitNotices(limitBlocks, searchedSources) || null, queueItems };
        }
        if (result.outcome !== "matched" && result.outcome !== "skipped") {
          const seed = queueSeed(comic.id, result.limitBlocks);
          if (seed) queueItems.push(seed);
        }
        if (result.outcome === "matched") proposed += 1;
        else if (result.outcome === "skipped") skipped += 1;
        else {
          noCandidate += 1;
          misses = addMiss(misses, result.message);
        }
        cursorSettled = true;
        if (!beat("running", "Edition re-match: running", null)) {
          return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
        }
      } catch (error) {
        if (error instanceof MetronBudgetError) {
          const block = limitBlockFromError(error, sharedMetronLimiter().snapshot());
          if (block) {
            limitBlocks.push(block);
            const seed = queueSeed(comic.id, [block]);
            if (seed) queueItems.push(seed);
          }
          await closeMetron(error);
          const job = readEditionJob();
          if (job?.state === "error") {
            return { ok: false, message: job.message ?? "Edition re-match resume failed.", notice: null, queueItems };
          }
          const message = job?.message ?? "Edition re-match paused. It will resume.";
          return { ok: true, message, notice: limitNotices(limitBlocks, searchedSources) || null, queueItems };
        }
        if (error instanceof GcdBudgetError) {
          const block = limitBlockFromError(error);
          if (block) {
            limitBlocks.push(block);
            const seed = queueSeed(comic.id, [block]);
            if (seed) queueItems.push(seed);
          }
          await noteGcdPause(error);
          noCandidate += 1;
          misses = addMiss(misses, "GCD is paused.");
          cursorSettled = true;
          if (!beat("running", "Edition re-match: running", null)) {
            return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
          }
          continue;
        }
        noCandidate += 1;
        misses = addMiss(misses, error instanceof Error ? error.message : "Re-match failed.");
        cursorSettled = true;
        if (!beat("running", "Edition re-match: running", null)) {
          return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
        }
      }
    }
    if (pauseRequested) {
      const job = readEditionJob();
      const message = job?.message ?? summaryLine(counts(), false);
      return { ok: true, message, notice: limitNotices(limitBlocks, searchedSources) || null, queueItems };
    }
    const message = summaryLine(counts(), true);
    if (!beat("finished", "Edition re-match: finished", null)) {
      return { ok: true, message: "Edition re-match cleared.", notice: null, queueItems };
    }
    const notice = limitNotices(limitBlocks, searchedSources) || null;
    await writeLog({
      level: "info",
      source: "covers/backfill",
      message: notice ? `${message} ${notice}` : message,
      details: { attempted, proposed, noCandidate, skipped, misses },
    });
    return { ok: true, message, notice, queueItems };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Edition re-match failed.";
    failEditionJob(message);
    return { ok: false, message, notice: null, queueItems: [] };
  } finally {
    if (scope === "full") {
      const live = fullRunMetronUsed();
      const current = readEditionJob();
      if (current?.runId === runId) {
        writeJob({ state: current.state, metronCalls: live.used, metronDay: live.day || null });
      }
      clearFullRunCap();
    }
    releaseEditionRematchLock();
  }
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
  if (existing?.mode === "propose") return false;
  const resuming = existing?.state === "paused" || existing?.state === "stale" || existing?.state === "error";
  const runId = continuedRunId(resuming, existing?.runId, () => randomBytes(8).toString("hex"));
  pauseRequested = false;
  writeJob({
    state: "running",
    message: "Edition re-match: running",
    resumeAt: null,
    metronResumeAt: existing?.metronResumeAt && Date.parse(existing.metronResumeAt) > Date.now() ? existing.metronResumeAt : null,
    matched: resuming ? (existing?.matched ?? 0) : 0,
    unmatched: resuming ? (existing?.unmatched ?? 0) : 0,
    attempted: resuming ? (existing?.attempted ?? 0) : 0,
    proposed: resuming ? (existing?.proposed ?? 0) : 0,
    noCandidate: resuming ? (existing?.noCandidate ?? 0) : 0,
    skipped: resuming ? (existing?.skipped ?? 0) : 0,
    cursorId: resuming ? (existing?.cursorId ?? null) : null,
    misses: resuming ? (existing?.misses ?? {}) : {},
    heartbeatAt: new Date().toISOString(),
    runId,
    mode: "apply",
  });
  const summary = await runFacsimilePass({
    already: rematchAlreadyDone,
    cursorId: resuming ? (existing?.cursorId ?? null) : null,
    markDone: async () => {
      if (!editionRematchLockOwned()) return;
      await prisma.appSetting.upsert({
        where: { key: FACSIMILE_REMATCH_KEY },
        create: { key: FACSIMILE_REMATCH_KEY, plain: "done", secret: null },
        update: { plain: "done", secret: null },
      });
    },
    onProgress: () => {
      if (pauseRequested || readEditionJob()?.runId !== runId) return false;
      writeJob({ state: "running", heartbeatAt: new Date().toISOString(), runId, mode: "apply" });
      return true;
    },
    ids: async () => {
      const [comics, years, printings] = await Promise.all([
        prisma.comic.findMany({
          where: { OR: [{ metronIssueId: { not: null } }, { gcdIssueId: { not: null } }] },
          select: linkedSelect,
          orderBy: { id: "asc" },
        }),
        readCatalogYears(),
        readPrintingCovers(),
      ]);
      return comics.flatMap((comic) => {
        const reason = suspectMatchReason({ ...comic, catalogStoreYear: years[comic.id] ?? null, catalogPrinting: printings[comic.id] ?? null });
        if (!reason) return [];
        const manual = Boolean(proposalBlocked(comic.manualLink, comic.fieldSources));
        return [{ id: comic.id, manual }];
      });
    },
    rematch: async (id, ctx) => {
      if (!refreshEditionRematchLock()) return "stopped";
      if (readEditionJob()?.runId !== runId) return "stopped";
      try {
        const result = await rematchShelfCopy(id, { metron: ctx?.metron !== false });
        if (!pauseRequested && readEditionJob()?.runId === runId) {
          writeJob({ state: "running", cursorId: id, heartbeatAt: new Date().toISOString(), runId, mode: "apply" });
        }
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
        const message = error instanceof Error ? error.message : "Facsimile re-match failed.";
        await writeLog({ level: "warn", source: "covers/backfill", message, details: { comicId: id } });
        return "unmatched";
      }
    },
  });
  if (!editionRematchLockOwned()) return false;
  if (readEditionJob()?.runId !== runId) return false;
  const attempted = (resuming ? (existing?.attempted ?? 0) : 0) + summary.matched + summary.unmatched + summary.skipped;
  const proposed = (resuming ? (existing?.proposed ?? 0) : 0) + summary.matched;
  const noCandidate = (resuming ? (existing?.noCandidate ?? 0) : 0) + summary.unmatched;
  if (summary.done) {
    const message = summaryLine({ attempted, proposed, noCandidate, misses: existing?.misses ?? {} }, true);
    writeJob({
      state: "finished",
      message: "Edition re-match: finished",
      resumeAt: null,
      metronResumeAt: null,
      matched: proposed,
      unmatched: noCandidate,
      attempted,
      proposed,
      noCandidate,
      skipped: (resuming ? (existing?.skipped ?? 0) : 0) + summary.skipped,
      runId,
      mode: "apply",
    });
    if (attempted > 0) {
      await writeLog({ level: "info", source: "covers/backfill", message, details: { attempted, proposed, noCandidate, skipped: summary.skipped } });
    }
  } else {
    const job = readEditionJob();
    const resumeAt = job?.resumeAt ?? (metronClosedUntil > Date.now() ? new Date(metronClosedUntil).toISOString() : null);
    writeJob({
      state: "paused",
      message: job?.message ?? "Edition re-match: paused",
      resumeAt,
      metronResumeAt: job?.metronResumeAt ?? (metronClosedUntil > Date.now() ? new Date(metronClosedUntil).toISOString() : null),
      matched: proposed,
      unmatched: noCandidate,
      attempted,
      proposed,
      noCandidate,
      skipped: (resuming ? (existing?.skipped ?? 0) : 0) + summary.skipped,
      runId,
      mode: "apply",
    });
    if (resumeAt) {
      const at = Date.parse(resumeAt);
      if (!resumeTimer) wakeLater(Number.isFinite(at) ? at : Date.now() + 1_000);
    } else {
      failEditionJob("Edition re-match paused without a resume time.");
    }
  }
  return summary.done;
}
