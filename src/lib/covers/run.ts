import type { Prisma } from "@prisma/client";
import { collectedText } from "@/lib/catalog/link-plan";
import { saveChosenCover } from "@/lib/catalog/link-issue";
import { readManualLink, stripLockedCover, withLinkedId } from "@/lib/catalog/manual-link";
import { coverPublicPath, backfillCovers, type BackfillSummary } from "@/lib/covers/backfill";
import { blankCrossIds } from "@/lib/covers/cross-link";
import { crossLinkShelf, linkMetronFromForeignIds } from "@/lib/covers/cross-link-run";
import { planEnrichment, type EnrichmentPlan, type MetronDetails, type MetronField } from "@/lib/covers/enrich";
import { writePrintingCover } from "@/lib/covers/facsimile-years";
import { logCoverFinished, logCoverProgress, logCoverStarted, logEnrichFinished, logEnrichStarted, logMetronFill } from "@/lib/log/events";
import { coverLineLevel } from "@/lib/log/query";
import { writeLog } from "@/lib/log/write";
import {
  acquireBackfillLock,
  backfillLockHeld,
  coverExists,
  coversDir,
  downloadCover,
  releaseBackfillLock,
  writeBackfillStatus,
  type BackfillStatus,
} from "@/lib/covers/files";
import { createGcdCatalog } from "@/lib/catalog/gcd";
import { gcdDetails, resolveGcdCover } from "@/lib/covers/gcd-match";
import { resolveCover } from "@/lib/covers/match";
import { createMetronCoverLookup, fetchMetronIssueRecord, metronBasicAuth, metronIssuesByCrossId, metronTransport, type MetronTransport } from "@/lib/covers/metron-client";
import { budgetPauseMessage, recordBudgetPause } from "@/lib/covers/budget-pause";
import { needsReviewNote } from "@/lib/covers/printing-cover";
import { MetronBudgetError, type CoverRecord } from "@/lib/covers/types";
import { prisma } from "@/lib/db";
import { getPreferences, setCoversPaused } from "@/lib/settings/service";

const enrichSelect = {
  coverDate: true,
  coverYear: true,
  releaseDate: true,
  title: true,
  storyArc: true,
  plot: true,
  pageCount: true,
  coverPrice: true,
  barcode: true,
  writer: true,
  artist: true,
  coverArtist: true,
  characters: true,
  teams: true,
  imprint: true,
  seriesYear: true,
  seriesVolume: true,
  metronIssueId: true,
  metronSeriesId: true,
  metronIssueUrl: true,
  metronSeriesUrl: true,
  comicvineIssueId: true,
  comicvineSeriesId: true,
  gcdIssueId: true,
  gcdSeriesId: true,
  fieldSources: true,
  manualLink: true,
  collects: true,
} as const;

const globalBackfill = globalThis as unknown as { longboxCoverBackfill?: Promise<unknown> };

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
      variantDescription: true,
      title: true,
      fullTitle: true,
      format: true,
      shelfFormat: true,
      subtitle: true,
      publisher: true,
      releaseYear: true,
      releaseDate: true,
      seriesYear: true,
      coverPrice: true,
      coverFile: true,
      coverStatus: true,
      metronIssueId: true,
      gcdIssueId: true,
      comicvineIssueId: true,
      manualLink: true,
    },
  });
  return rows.map((row) => {
    const link = readManualLink(row.manualLink);
    return {
      id: row.id,
      series: row.series,
      issue: row.issue,
      issueNo: row.issueNo,
      coverYear: row.coverYear,
      barcode: row.barcode,
      variant: row.variant,
      variantDescription: row.variantDescription,
      title: row.title,
      fullTitle: row.fullTitle,
      format: row.format,
      shelfFormat: row.shelfFormat,
      subtitle: row.subtitle,
      publisher: row.publisher,
      releaseYear: row.releaseYear,
      releaseDate: row.releaseDate,
      seriesYear: row.seriesYear,
      coverPrice: row.coverPrice,
      coverFile: row.coverFile,
      coverStatus: row.coverStatus,
      metronIssueId: row.metronIssueId,
      gcdIssueId: row.gcdIssueId,
      comicvineIssueId: row.comicvineIssueId,
      manualMetronIssueId: link.metronIssueId,
      manualGcdIssueId: link.gcdIssueId,
      manualCoverImageUrl: link.coverImageUrl,
      userCover: link.userCover,
    };
  });
}

function statusFrom(
  summary: BackfillSummary,
  running: boolean,
  startedAt: string,
  message: string | null,
  task: "covers" | "enrich" = "covers",
): BackfillStatus {
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
    task,
  };
}

function issueLabel(series: string, issueNo: string | null, issue: string | null): string {
  return `${series} #${issueNo || issue || "?"}`;
}

async function readEnrichment(id: string) {
  return prisma.comic.findUnique({ where: { id }, select: enrichSelect });
}

export async function applyEnrichment(
  id: string,
  detail: MetronDetails | null,
  extra: Prisma.ComicUpdateInput,
): Promise<string[]> {
  const current = await readEnrichment(id);
  const fill = detail != null && (await getPreferences()).covers.fillMissing;
  const plan = fill && current ? planEnrichment(current, detail, current.fieldSources) : null;
  const data: Prisma.ComicUpdateInput = { ...extra };
  if (plan && plan.filled.length > 0) {
    Object.assign(data, enrichmentPatch(plan));
  }
  if (detail && current) {
    const collected = collectedText(current, current.fieldSources, detail);
    if (collected) data.collects = collected;
    const cross = blankCrossIds(current, current.fieldSources, current.manualLink, detail);
    Object.assign(data, cross);
    if (cross.comicvineIssueId) {
      await writeLog({
        level: "info",
        source: "metron",
        message: `Stored Comic Vine ${cross.comicvineIssueId} from Metron ${detail.id}.`,
        details: { comicId: id, metronIssueId: detail.id, comicvineIssueId: cross.comicvineIssueId },
      });
    }
    if (cross.gcdIssueId) {
      await writeLog({
        level: "info",
        source: "metron",
        message: `Stored GCD ${cross.gcdIssueId} from Metron ${detail.id}.`,
        details: { comicId: id, metronIssueId: detail.id, gcdIssueId: cross.gcdIssueId },
      });
    }
  }
  const replacingLink = extra.manualLink !== undefined;
  const link = readManualLink(current?.manualLink);
  if (!replacingLink && link.metronIssueId) data.metronIssueId = link.metronIssueId;
  if (!replacingLink && link.comicvineIssueId) data.comicvineIssueId = link.comicvineIssueId;
  if (!replacingLink && link.gcdIssueId) data.gcdIssueId = link.gcdIssueId;
  stripLockedCover(data, current?.manualLink);
  if (Object.keys(data).length > 0) {
    await prisma.comic.update({ where: { id }, data });
  }
  return plan?.filled ?? [];
}

export async function applyGcdLink(
  id: string,
  gcdIssueId: string,
  gcdSeriesId: string | null,
  score: number,
  detail: MetronDetails | null,
  options?: { coverReview?: string | null; printing?: number | null },
): Promise<string[]> {
  const current = await readEnrichment(id);
  const fill = detail != null && (await getPreferences()).covers.fillMissing;
  const plan = fill && current ? planEnrichment(current, detail, current.fieldSources, "gcd") : null;
  const data: Prisma.ComicUpdateInput = {
    gcdIssueId,
    gcdSeriesId,
    coverStatus: "gcd",
    coverNote: options?.coverReview ? needsReviewNote(options.coverReview) : `Linked GCD ${gcdIssueId}, score ${score}. Cover stays on GCD.`,
    coverCheckedAt: new Date(),
  };
  if (plan && plan.filled.length > 0) Object.assign(data, enrichmentPatch(plan));
  if (detail && current) {
    const collected = collectedText(current, current.fieldSources, detail);
    if (collected) data.collects = collected;
    Object.assign(data, blankCrossIds(current, current.fieldSources, current.manualLink, detail));
  }
  const gcdLink = readManualLink(current?.manualLink);
  if (gcdLink.gcdIssueId) data.gcdIssueId = gcdLink.gcdIssueId;
  stripLockedCover(data, current?.manualLink);
  await prisma.comic.update({ where: { id }, data });
  if (options && options.printing !== undefined) await writePrintingCover(id, options.printing);
  return plan?.filled ?? [];
}

function enrichmentPatch(plan: EnrichmentPlan): Prisma.ComicUpdateInput {
  const data: Prisma.ComicUpdateInput = { fieldSources: plan.sources };
  for (const field of plan.filled) {
    assignField(data, field, plan.patch[field]);
  }
  return data;
}

function assignField(data: Prisma.ComicUpdateInput, field: MetronField, value: string | number | Date | undefined) {
  if (value == null) return;
  switch (field) {
    case "coverDate":
    case "title":
    case "storyArc":
    case "plot":
    case "barcode":
    case "writer":
    case "artist":
    case "coverArtist":
    case "characters":
    case "teams":
    case "imprint":
    case "metronIssueId":
    case "metronSeriesId":
    case "metronIssueUrl":
    case "metronSeriesUrl":
    case "comicvineIssueId":
    case "comicvineSeriesId":
      data[field] = String(value);
      return;
    case "coverYear":
    case "pageCount":
    case "seriesYear":
    case "seriesVolume":
      data[field] = typeof value === "number" ? value : Number(value);
      return;
    case "coverPrice":
      data.coverPrice = String(value);
      return;
    case "releaseDate":
      data.releaseDate = value instanceof Date ? value : new Date(String(value));
      return;
    default:
      return;
  }
}

function matchedCoverPatch(update: {
  metronIssueId: string;
  coverFile: string | null;
  coverUrl: string | null;
  coverNote?: string | null;
}): Prisma.ComicUpdateInput {
  const saved = Boolean(update.coverFile);
  return {
    metronIssueId: update.metronIssueId,
    coverFile: update.coverFile,
    coverUrl: update.coverUrl,
    coverStatus: saved ? "matched" : null,
    coverNote: update.coverNote !== undefined ? update.coverNote : null,
    coverCheckedAt: new Date(),
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
  const { scheduleFacsimileRematch } = await import("@/lib/covers/facsimile-rematch");
  const { ensureShelfFormats } = await import("@/lib/shelf-format-backfill");
  scheduleFacsimileRematch();
  await ensureShelfFormats();
  const dir = coversDir();
  const transport = await metronTransport();
  const lookup = createMetronCoverLookup(transport);
  await crossLinkShelf(emit);
  writeBackfillStatus(statusFrom({ pending: 0, matched: 0, unmatched: 0, skipped: 0, stoppedReason: null }, true, startedAt, "Looking up covers on Metron."));
  const comics = await loadComics();
  const labels = new Map(comics.map((comic) => [comic.id, issueLabel(comic.series, comic.issueNo, comic.issue)]));
  await logCoverStarted(comics.length);
  let progressMarks = 0;
  const summary = await backfillCovers({
    comics,
    lookup,
    fileExists: (filename) => coverExists(dir, filename),
    loadDetail: (issueId) => loadMatchedIssue(transport, issueId),
    loadIssue: (issueId) => fetchMetronIssueRecord(transport, issueId),
    saveImage: async (issue) => {
      if (!issue.imageUrl) throw new Error(`Metron issue ${issue.id} has no cover image.`);
      return downloadCover(issue.imageUrl, issue.id, dir);
    },
    markMatched: async (id, update, detail) => {
      const filled = await applyEnrichment(id, detail, matchedCoverPatch(update));
      if (update.printing !== undefined) await writePrintingCover(id, update.printing);
      if (detail && (await getPreferences()).covers.fillMissing) {
        await logMetronFill(labels.get(id) ?? id, update.metronIssueId, filled);
      }
    },
    markUnmatched: async (id, reason) => {
      await prisma.comic.update({
        where: { id },
        data: { coverStatus: "unmatched", coverNote: reason, coverCheckedAt: new Date() },
      });
    },
    gcd: (comic) => resolveGcdCover(comic, createGcdCatalog()),
    crossLookup: {
      byComicVine: (id) => metronIssuesByCrossId(transport, "cv_id", id),
      byGcd: (id) => metronIssuesByCrossId(transport, "gcd_id", id),
    },
    markGcd: async (id, update) => {
      const issue = await createGcdCatalog().issue(update.gcdIssueId);
      const detail = issue ? gcdDetails(issue) : null;
      const filled = await applyGcdLink(id, update.gcdIssueId, update.gcdSeriesId, update.score, detail, {
        coverReview: update.coverReview,
        printing: update.printing,
      });
      if (issue?.metronIssueId) await linkMetronFromForeignIds(id, issue.metronIssueId);
      if (detail && filled.length > 0) {
        await writeLog({
          level: "info",
          source: "gcd",
          message: `Filled ${filled.join(", ")} on ${labels.get(id) ?? id} from GCD ${update.gcdIssueId}, score ${update.score}.`,
          details: { comicId: id, gcdIssueId: update.gcdIssueId, score: update.score, fields: filled },
        });
      }
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

async function loadMatchedIssue(transport: MetronTransport, issueId: string): Promise<MetronDetails | null> {
  if (!(await getPreferences()).covers.fillMissing) return null;
  try {
    return await fetchMetronIssueRecord(transport, issueId);
  } catch (error) {
    if (error instanceof MetronBudgetError) throw error;
    const message = error instanceof Error ? error.message : "Could not read the Metron issue.";
    await writeLog({
      level: "warn",
      source: "metron",
      message: `Metron issue ${issueId} details were not read. ${message}`,
      details: { metronIssueId: issueId },
    });
    return null;
  }
}

export async function attachMetronCover(comicId: string, metronIssueId: string): Promise<void> {
  if (!/^\d+$/.test(metronIssueId)) throw new Error("Enter a numeric Metron issue id.");
  if (!(await metronBasicAuth())) throw new Error("Set Metron username and password in Settings or the environment.");
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) throw new Error("A cover backfill is already running.");
  const detail = await fetchMetronIssueRecord(await metronTransport(), metronIssueId);
  if (!detail?.imageUrl) throw new Error(`Metron issue ${metronIssueId} has no cover image.`);
  const filename = await downloadCover(detail.imageUrl, detail.id, undefined, { force: true });
  const existing = await prisma.comic.findUnique({ where: { id: comicId }, select: { manualLink: true } });
  const filled = await applyEnrichment(comicId, detail, {
    metronIssueId: detail.id,
    manualLink: withLinkedId(existing?.manualLink, "metron", detail.id, detail.imageUrl),
    coverFile: filename,
    coverUrl: coverPublicPath(filename),
    coverStatus: "matched",
    coverNote: null,
    coverCheckedAt: new Date(),
  });
  if ((await getPreferences()).covers.fillMissing) await logMetronFill(`issue ${comicId}`, detail.id, filled);
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
      variantDescription: true,
      title: true,
      fullTitle: true,
      format: true,
      shelfFormat: true,
      subtitle: true,
      publisher: true,
      releaseYear: true,
      coverPrice: true,
      coverFile: true,
      coverStatus: true,
      metronIssueId: true,
      gcdIssueId: true,
      comicvineIssueId: true,
      manualLink: true,
    },
  });
  if (!comic) throw new Error("That issue is not on the shelf.");
  const locked = readManualLink(comic.manualLink);
  const label = issueLabel(comic.series, comic.issueNo, comic.issue);
  if (locked.userCover) {
    const message = `The cover on ${label} was uploaded and was left as it is.`;
    await writeLog({ level: "info", source: "covers/backfill", message, details: { comicId } });
    return message;
  }
  if (locked.gcdIssueId) {
    const message = `The GCD link on ${label} was chosen by hand and was left as it is.`;
    await writeLog({ level: "info", source: "gcd", message, details: { comicId } });
    return message;
  }
  if (locked.metronIssueId || locked.comicvineIssueId || locked.coverImageUrl) {
    if (!acquireBackfillLock()) throw new Error("A cover backfill is already running.");
    try {
      const saved = await saveChosenCover(comicId);
      if (!saved.ok) throw new Error(saved.message);
      return saved.message;
    } finally {
      releaseBackfillLock();
    }
  }
  if (!(await metronBasicAuth())) throw new Error("Set Metron username and password in Settings or the environment.");
  if (!acquireBackfillLock()) throw new Error("A cover backfill is already running.");
  try {
    const transport = await metronTransport();
    const lookup = createMetronCoverLookup(transport);
    const summary = await backfillCovers({
      comics: [{ ...comic, coverFile: null, coverStatus: null }],
      lookup,
      fileExists: () => false,
      loadDetail: (issueId) => loadMatchedIssue(transport, issueId),
      saveImage: async (issue) => {
        if (!issue.imageUrl) throw new Error(`Metron issue ${issue.id} has no cover image.`);
        return downloadCover(issue.imageUrl, issue.id);
      },
      markMatched: async (id, update, detail) => {
        const filled = await applyEnrichment(id, detail, matchedCoverPatch(update));
        if (update.printing !== undefined) await writePrintingCover(id, update.printing);
        if (detail && (await getPreferences()).covers.fillMissing) {
          await logMetronFill(label, update.metronIssueId, filled);
        }
      },
      markUnmatched: async (id, reason) => {
        await prisma.comic.update({
          where: { id },
          data: { coverStatus: "unmatched", coverNote: reason, coverCheckedAt: new Date() },
        });
      },
      gcd: (row) => resolveGcdCover(row, createGcdCatalog()),
      crossLookup: {
        byComicVine: (id) => metronIssuesByCrossId(transport, "cv_id", id),
        byGcd: (id) => metronIssuesByCrossId(transport, "gcd_id", id),
      },
      markGcd: async (id, update) => {
        const issue = await createGcdCatalog().issue(update.gcdIssueId);
        const detail = issue ? gcdDetails(issue) : null;
        const filled = await applyGcdLink(id, update.gcdIssueId, update.gcdSeriesId, update.score, detail, {
          coverReview: update.coverReview,
          printing: update.printing,
        });
        if (issue?.metronIssueId) await linkMetronFromForeignIds(id, issue.metronIssueId);
        if (detail && filled.length > 0) {
          await writeLog({
            level: "info",
            source: "gcd",
            message: `Filled ${filled.join(", ")} on ${label} from GCD ${update.gcdIssueId}, score ${update.score}.`,
            details: { comicId: id, gcdIssueId: update.gcdIssueId, score: update.score, fields: filled },
          });
        }
      },
    });
    if (summary.matched > 0) {
      const linked = await prisma.comic.findUnique({ where: { id: comicId }, select: { coverStatus: true, gcdIssueId: true } });
      const message =
        linked?.coverStatus === "gcd"
          ? `Linked ${label} on GCD ${linked.gcdIssueId ?? ""}. Cover stays on GCD.`
          : `Fetched a cover for ${label}.`;
      await writeLog({ level: "info", source: linked?.coverStatus === "gcd" ? "gcd" : "covers/backfill", message, details: summary });
      return message;
    }
    const message = summary.stoppedReason ?? `No cover matched for ${label}.`;
    await writeLog({ level: "warn", source: "covers/backfill", message, details: summary });
    return message;
  } finally {
    releaseBackfillLock();
  }
}

export async function startMetronEnrichmentInBackground(): Promise<"started" | "busy" | "unconfigured" | "disabled"> {
  if (!(await metronBasicAuth())) return "unconfigured";
  if (!(await getPreferences()).covers.fillMissing) return "disabled";
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) return "busy";
  await setCoversPaused(false);
  if (!acquireBackfillLock()) return "busy";
  globalBackfill.longboxCoverBackfill = runMetronEnrichment()
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Metron enrichment failed.";
      await writeLog({ level: "error", source: "metron", message });
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
        task: "enrich",
      });
    })
    .finally(() => {
      releaseBackfillLock();
      globalBackfill.longboxCoverBackfill = undefined;
    });
  return "started";
}

async function runMetronEnrichment(): Promise<void> {
  const startedAt = new Date().toISOString();
  const comics = await prisma.comic.findMany({
    where: { metronIssueId: { not: null } },
    orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
    select: { id: true, series: true, issue: true, issueNo: true, metronIssueId: true },
  });
  const summary = { pending: comics.length, matched: 0, unmatched: 0, skipped: 0, stoppedReason: null as string | null };
  writeBackfillStatus(statusFrom(summary, true, startedAt, "Filling missing details from Metron.", "enrich"));
  await logEnrichStarted(comics.length);
  const transport = await metronTransport();
  for (const comic of comics) {
    const prefs = await getPreferences();
    if (!prefs.covers.fillMissing) {
      summary.stoppedReason = "Fill missing details from Metron is off.";
      break;
    }
    if (prefs.covers.paused) {
      summary.stoppedReason = "Paused.";
      break;
    }
    const metronIssueId = comic.metronIssueId ?? "";
    const label = issueLabel(comic.series, comic.issueNo, comic.issue);
    try {
      const detail = await fetchMetronIssueRecord(transport, metronIssueId);
      if (!detail) {
        summary.unmatched += 1;
        await writeLog({
          level: "warn",
          source: "metron",
          message: `${label} has no Metron issue ${metronIssueId}.`,
          details: { comicId: comic.id, metronIssueId },
        });
      } else {
        const filled = await applyEnrichment(comic.id, detail, {});
        if (filled.length > 0) summary.matched += 1;
        else summary.skipped += 1;
        await logMetronFill(label, detail.id, filled);
      }
    } catch (error) {
      if (error instanceof MetronBudgetError) {
        const pause = await recordBudgetPause("Metron enrichment", error);
        summary.stoppedReason = budgetPauseMessage("Metron enrichment", pause);
        break;
      }
      summary.unmatched += 1;
      const message = error instanceof Error ? error.message : "Could not enrich this issue.";
      await writeLog({ level: "warn", source: "metron", message: `${label}: ${message}`, details: { comicId: comic.id, metronIssueId } });
    }
    writeBackfillStatus(statusFrom(summary, true, startedAt, null, "enrich"));
  }
  const message = summary.stoppedReason ?? `Filled ${summary.matched}. Unchanged ${summary.skipped}.`;
  writeBackfillStatus(statusFrom(summary, false, startedAt, message, "enrich"));
  await logEnrichFinished({
    filled: summary.matched,
    unchanged: summary.skipped,
    failed: summary.unmatched,
    stoppedReason: summary.stoppedReason,
  });
}

export async function refreshIssueFromMetron(comicId: string): Promise<{ ok: boolean; message: string }> {
  if (!(await getPreferences()).covers.fillMissing) {
    const message = "Turn on Fill missing details from Metron in Settings.";
    await writeLog({ level: "info", source: "metron", message, details: { comicId } });
    return { ok: false, message };
  }
  if (!(await metronBasicAuth())) {
    const message = "Set Metron username and password in Settings or the environment.";
    await writeLog({ level: "warn", source: "metron", message, details: { comicId } });
    return { ok: false, message };
  }
  if (globalBackfill.longboxCoverBackfill || backfillLockHeld()) {
    const message = "A Metron run is already going. Wait for it to finish.";
    await writeLog({ level: "info", source: "metron", message, details: { comicId } });
    return { ok: false, message };
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
      variantDescription: true,
      format: true,
      shelfFormat: true,
      title: true,
      fullTitle: true,
      subtitle: true,
      publisher: true,
      releaseYear: true,
      releaseDate: true,
      seriesYear: true,
      coverPrice: true,
      metronIssueId: true,
    },
  });
  if (!comic) return { ok: false, message: "That issue is not on the shelf." };
  if (!acquireBackfillLock()) return { ok: false, message: "A Metron run is already going. Wait for it to finish." };
  const label = issueLabel(comic.series, comic.issueNo, comic.issue);
  try {
    const transport = await metronTransport();
    let metronIssueId = comic.metronIssueId;
    if (!metronIssueId) {
      const decision = await resolveCover(comic, createMetronCoverLookup(transport));
      if (decision.status !== "matched") {
        await writeLog({ level: "warn", source: "metron", message: decision.reason, details: { comicId } });
        return { ok: false, message: decision.reason };
      }
      metronIssueId = decision.issue.id;
    }
    const detail = await fetchMetronIssueRecord(transport, metronIssueId);
    if (!detail) {
      const message = `Metron issue ${metronIssueId} could not be read.`;
      await writeLog({ level: "warn", source: "metron", message, details: { comicId, metronIssueId } });
      return { ok: false, message };
    }
    const filled = await applyEnrichment(comic.id, detail, {});
    await logMetronFill(label, detail.id, filled);
    if (filled.length === 0) return { ok: true, message: `${label} had nothing missing.` };
    return { ok: true, message: `Filled ${filled.join(", ")} on ${label}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not refresh this issue from Metron.";
    await writeLog({ level: "error", source: "metron", message, details: { comicId } });
    return { ok: false, message };
  } finally {
    releaseBackfillLock();
  }
}

export async function queueCoverRetry(comicId: string): Promise<void> {
  const comic = await prisma.comic.findUnique({ where: { id: comicId }, select: { manualLink: true } });
  if (readManualLink(comic?.manualLink).userCover) return;
  await prisma.comic.update({
    where: { id: comicId },
    data: { coverStatus: null, coverNote: null, coverCheckedAt: null },
  });
}
