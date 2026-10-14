import { coverPublicPath, backfillCovers, type BackfillSummary } from "@/lib/covers/backfill";
import { logCoverFinished, logCoverProgress, logCoverStarted } from "@/lib/log/events";
import { coverLineLevel } from "@/lib/log/query";
import { writeLog } from "@/lib/log/write";
import {
  acquireBackfillLock,
  backfillLockHeld,
  coverExists,
  coversDir,
  downloadCover,
  fileBudgetStore,
  releaseBackfillLock,
  writeBackfillStatus,
  type BackfillStatus,
} from "@/lib/covers/files";
import { budgetDay, MetronLimiter } from "@/lib/covers/limiter";
import { createMetronCoverLookup, fetchMetronIssue, metronBaseUrl, metronBasicAuth, type MetronTransport } from "@/lib/covers/metron-client";
import type { CoverRecord } from "@/lib/covers/types";
import { prisma } from "@/lib/db";
import { getPreferences, setCoversPaused } from "@/lib/settings/service";

const globalBackfill = globalThis as unknown as { longboxCoverBackfill?: Promise<unknown> };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function metronTransport(): Promise<MetronTransport> {
  const auth = await metronBasicAuth();
  if (!auth) throw new Error("Set Metron username and password in Settings or the environment.");
  return {
    fetch,
    limiter: new MetronLimiter(
      fileBudgetStore(),
      () => Date.now(),
      sleep,
      () => budgetDay(new Date()),
    ),
    username: auth.username,
    password: auth.password,
    baseUrl: await metronBaseUrl(),
    now: () => Date.now(),
  };
}

async function loadComics(): Promise<CoverRecord[]> {
  const rows = await prisma.comic.findMany({
    where: { OR: [{ coverStatus: null }, { coverStatus: "matched" }] },
    orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
    select: {
      id: true,
      series: true,
      issue: true,
      issueNo: true,
      coverYear: true,
      barcode: true,
      variant: true,
      publisher: true,
      coverFile: true,
      coverStatus: true,
      metronIssueId: true,
    },
  });
  return rows;
}

function statusFrom(summary: BackfillSummary, running: boolean, startedAt: string, message: string | null): BackfillStatus {
  return {
    running,
    startedAt,
    finishedAt: running ? null : new Date().toISOString(),
    matched: summary.matched,
    unmatched: summary.unmatched,
    skipped: summary.skipped,
    pending: summary.pending,
    stoppedReason: summary.stoppedReason,
    message,
  };
}

export async function runCoverBackfill(log: (line: string) => void = console.log): Promise<BackfillSummary> {
  const startedAt = new Date().toISOString();
  const emit = (line: string) => {
    log(line);
    void writeLog({ level: coverLineLevel(line), source: "covers/backfill", message: line });
  };
  try {
    return await runCoverBackfillBody(emit, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cover backfill failed.";
    log(message);
    await writeLog({ level: "error", source: "covers/backfill", message });
    throw error;
  }
}

async function runCoverBackfillBody(emit: (line: string) => void, startedAt: string): Promise<BackfillSummary> {
  const dir = coversDir();
  const lookup = createMetronCoverLookup(await metronTransport());
  writeBackfillStatus(statusFrom({ pending: 0, matched: 0, unmatched: 0, skipped: 0, stoppedReason: null }, true, startedAt, "Looking up covers on Metron."));
  const comics = await loadComics();
  await logCoverStarted(comics.length);
  let progressMarks = 0;
  const summary = await backfillCovers({
    comics,
    lookup,
    fileExists: (filename) => coverExists(dir, filename),
    saveImage: async (issue) => {
      if (!issue.imageUrl) throw new Error(`Metron issue ${issue.id} has no cover image.`);
      return downloadCover(issue.imageUrl, issue.id, dir);
    },
    markMatched: async (id, update) => {
      await prisma.comic.update({
        where: { id },
        data: {
          metronIssueId: update.metronIssueId,
          coverFile: update.coverFile,
          coverUrl: update.coverUrl,
          coverStatus: "matched",
          coverNote: null,
          coverCheckedAt: new Date(),
        },
      });
    },
    markUnmatched: async (id, reason) => {
      await prisma.comic.update({
        where: { id },
        data: { coverStatus: "unmatched", coverNote: reason, coverCheckedAt: new Date() },
      });
    },
    log: emit,
    onProgress: (current) => {
      writeBackfillStatus(statusFrom(current, true, startedAt, null));
      const checked = current.matched + current.unmatched;
      const mark = Math.floor(checked / 10);
      if (checked > 0 && mark > progressMarks) {
        progressMarks = mark;
        void logCoverProgress(current);
      }
    },
    shouldPause: async () => (await getPreferences()).covers.paused,
  });
  const message = summary.stoppedReason ?? `Matched ${summary.matched}. Unmatched ${summary.unmatched}.`;
  writeBackfillStatus(statusFrom(summary, false, startedAt, message));
  await logCoverFinished(summary);
  return summary;
}

export async function startCoverBackfillInBackground(): Promise<"started" | "busy" | "unconfigured"> {
  if (!(await metronBasicAuth())) return "unconfigured";
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) return "busy";
  await setCoversPaused(false);
  if (!acquireBackfillLock()) return "busy";
  globalBackfill.longboxCoverBackfill = runCoverBackfill()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Cover backfill failed.";
      writeBackfillStatus({
        running: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        matched: 0,
        unmatched: 0,
        skipped: 0,
        pending: 0,
        stoppedReason: message,
        message,
      });
    })
    .finally(() => {
      releaseBackfillLock();
      globalBackfill.longboxCoverBackfill = undefined;
    });
  return "started";
}

export async function attachMetronCover(comicId: string, metronIssueId: string): Promise<void> {
  if (!/^\d+$/.test(metronIssueId)) throw new Error("Enter a numeric Metron issue id.");
  if (!(await metronBasicAuth())) throw new Error("Set Metron username and password in Settings or the environment.");
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) throw new Error("A cover backfill is already running.");
  const issue = await fetchMetronIssue(await metronTransport(), metronIssueId);
  if (!issue?.imageUrl) throw new Error(`Metron issue ${metronIssueId} has no cover image.`);
  const filename = await downloadCover(issue.imageUrl, issue.id);
  await prisma.comic.update({
    where: { id: comicId },
    data: {
      metronIssueId: issue.id,
      coverFile: filename,
      coverUrl: coverPublicPath(filename),
      coverStatus: "matched",
      coverNote: null,
      coverCheckedAt: new Date(),
    },
  });
}

export async function refetchOneCover(comicId: string): Promise<string> {
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) {
    throw new Error("A cover backfill is already running.");
  }
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: {
      id: true,
      series: true,
      issue: true,
      issueNo: true,
      coverYear: true,
      barcode: true,
      variant: true,
      publisher: true,
      coverFile: true,
      coverStatus: true,
      metronIssueId: true,
    },
  });
  if (!comic) throw new Error("That issue is not on the shelf.");
  if (!(await metronBasicAuth())) throw new Error("Set Metron username and password in Settings or the environment.");
  if (!acquireBackfillLock()) throw new Error("A cover backfill is already running.");
  try {
    const lookup = createMetronCoverLookup(await metronTransport());
    const summary = await backfillCovers({
      comics: [{ ...comic, coverFile: null, coverStatus: null }],
      lookup,
      fileExists: () => false,
      saveImage: async (issue) => {
        if (!issue.imageUrl) throw new Error(`Metron issue ${issue.id} has no cover image.`);
        return downloadCover(issue.imageUrl, issue.id);
      },
      markMatched: async (id, update) => {
        await prisma.comic.update({
          where: { id },
          data: {
            metronIssueId: update.metronIssueId,
            coverFile: update.coverFile,
            coverUrl: update.coverUrl,
            coverStatus: "matched",
            coverNote: null,
            coverCheckedAt: new Date(),
          },
        });
      },
      markUnmatched: async (id, reason) => {
        await prisma.comic.update({
          where: { id },
          data: { coverStatus: "unmatched", coverNote: reason, coverCheckedAt: new Date() },
        });
      },
    });
    const label = `${comic.series} #${comic.issueNo || comic.issue || "?"}`;
    if (summary.matched > 0) {
      await writeLog({ level: "info", source: "covers/backfill", message: `Fetched a cover for ${label}.`, details: summary });
      return `Fetched a cover for ${label}.`;
    }
    const message = summary.stoppedReason ?? `No cover matched for ${label}.`;
    await writeLog({ level: "warn", source: "covers/backfill", message, details: summary });
    return message;
  } finally {
    releaseBackfillLock();
  }
}

export async function queueCoverRetry(comicId: string): Promise<void> {
  await prisma.comic.update({
    where: { id: comicId },
    data: { coverStatus: null, coverNote: null, coverCheckedAt: null },
  });
}
