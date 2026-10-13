import { coverPublicPath, backfillCovers, type BackfillSummary } from "@/lib/covers/backfill";
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

const globalBackfill = globalThis as unknown as { longboxCoverBackfill?: Promise<unknown> };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function metronTransport(): MetronTransport {
  const auth = metronBasicAuth();
  if (!auth) throw new Error("Set METRON_USERNAME and METRON_PASSWORD to backfill covers.");
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
    baseUrl: metronBaseUrl(),
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
  const dir = coversDir();
  const lookup = createMetronCoverLookup(metronTransport());
  writeBackfillStatus(statusFrom({ pending: 0, matched: 0, unmatched: 0, skipped: 0, stoppedReason: null }, true, startedAt, "Looking up covers on Metron."));
  const comics = await loadComics();
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
    log,
    onProgress: (current) => writeBackfillStatus(statusFrom(current, true, startedAt, null)),
  });
  const message = summary.stoppedReason ?? `Matched ${summary.matched}. Unmatched ${summary.unmatched}.`;
  writeBackfillStatus(statusFrom(summary, false, startedAt, message));
  return summary;
}

export function startCoverBackfillInBackground(): "started" | "busy" | "unconfigured" {
  if (!metronBasicAuth()) return "unconfigured";
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) return "busy";
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
  if (!metronBasicAuth()) throw new Error("Set METRON_USERNAME and METRON_PASSWORD to fetch a cover.");
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) throw new Error("A cover backfill is already running.");
  const issue = await fetchMetronIssue(metronTransport(), metronIssueId);
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

export async function queueCoverRetry(comicId: string): Promise<void> {
  await prisma.comic.update({
    where: { id: comicId },
    data: { coverStatus: null, coverNote: null, coverCheckedAt: null },
  });
}
