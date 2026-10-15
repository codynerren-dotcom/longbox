import { createGcdCatalog, GcdBudgetError } from "@/lib/catalog/gcd";
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
import { createMetronCoverLookup, fetchMetronIssueRecord, metronBasicAuth, metronTransport } from "@/lib/covers/metron-client";
import { needsReviewNote } from "@/lib/covers/printing-cover";
import { applyEnrichment, applyGcdLink } from "@/lib/covers/run";
import { MetronBudgetError, type CoverQuery, type MetronIssueHit } from "@/lib/covers/types";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import type { Prisma } from "@prisma/client";

let inflight: Promise<void> | null = null;
let finishedForProcess = false;
let nextAttemptAt = 0;
let metronClosedUntil = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

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
  if (finishedForProcess || inflight) return;
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

async function pauseForGcd(error: GcdBudgetError): Promise<void> {
  const pause = await recordBudgetPause("Edition re-match", error);
  const job = readEditionJob();
  const metronAt = metronClosedUntil > Date.now() ? metronClosedUntil : null;
  const resumeAt = metronAt != null ? Math.min(metronAt, pause.resumeAt) : pause.resumeAt;
  writeEditionJob({
    state: "paused",
    message: budgetPauseMessage("Edition re-match", pause),
    resumeAt: new Date(resumeAt).toISOString(),
    metronResumeAt: metronAt != null ? new Date(metronAt).toISOString() : (job?.metronResumeAt ?? null),
    matched: job?.matched ?? 0,
    unmatched: job?.unmatched ?? 0,
  });
  wakeLater(resumeAt);
}

export async function rematchShelfCopy(
  comicId: string,
  options?: { metron?: boolean },
): Promise<{ ok: boolean; message: string; outcome: RematchOutcome }> {
  const comic = await prisma.comic.findUnique({ where: { id: comicId } });
  if (!comic) return { ok: false, message: "That issue is not on the shelf.", outcome: "unmatched" };
  const link = readManualLink(comic.manualLink);
  if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId) {
    return { ok: false, message: "This link was chosen by hand. Unlink it first.", outcome: "skipped" };
  }
  if (link.userCover) {
    return { ok: false, message: "This cover was uploaded. Unlink the catalog id if you want, and the photo stays.", outcome: "skipped" };
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

  const linkGcd = async (): Promise<{ ok: true; message: string } | { ok: false; reason: string }> => {
    const gcd = await resolveGcdCover(query, createGcdCatalog());
    if (gcd.status !== "matched") return { ok: false, reason: gcd.reason };
    const { gcdDetails } = await import("@/lib/covers/gcd-match");
    const issue = await createGcdCatalog().issue(gcd.issue.id);
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
    return { ok: true, message };
  };

  const finish = async (matchedMessage: string | null): Promise<{ ok: boolean; message: string; outcome: RematchOutcome }> => {
    if (matchedMessage) return { ok: true, message: matchedMessage, outcome: "matched" };
    const outcome = editionOutcome({ matched: false, metronSkipped, gcdTried });
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
      return { ok: true, message: reason, outcome };
    }
    return { ok: false, message: reason, outcome };
  };

  try {
    if (gcdFirst) {
      gcdTried = true;
      const gcd = await linkGcd();
      if (gcd.ok) return finish(gcd.message);
      reason = gcd.reason || reason;
    }

    if (!metronSkipped && metronReady) {
      try {
        const transport = await metronTransport();
        const decision = await resolveCover(query, createMetronCoverLookup(transport));
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
          await clearAutomaticLink(comicId, "Re-matching.", { keepCover: keep });
          await applyEnrichment(comicId, detail, {
            metronIssueId: decision.issue.id,
            metronSeriesId: decision.issue.seriesId,
            ...(filename
              ? { coverFile: filename, coverUrl: coverPublicPath(filename), coverStatus: "matched", coverNote: null }
              : keep
                ? { coverNote: needsReviewNote(note), coverStatus: comic.coverFile ? comic.coverStatus : null }
                : { coverFile: null, coverUrl: null, coverStatus: null, coverNote: note }),
            coverCheckedAt: new Date(),
          });
          const year = catalogYear(decision.issue) ?? (detail?.releaseDate ? detail.releaseDate.getUTCFullYear() : null);
          await writeCatalogYear(comicId, year);
          if (printing.active) await writePrintingCover(comicId, filename ? printing.printing : null);
          const review = filename ? "" : note ? ` ${needsReviewNote(note)}` : "";
          const message = `Matched Metron ${decision.issue.id} (${decision.issue.seriesName} #${decision.issue.number}), score ${decision.score}.${review}`;
          await writeLog({ level: "info", source: "covers/backfill", message, details: { comicId, metronIssueId: decision.issue.id, score: decision.score } });
          return finish(message);
        }
        reason = decision.reason;
      } catch (error) {
        if (!(error instanceof MetronBudgetError)) throw error;
        await closeMetron(error);
        metronSkipped = true;
      }
    }

    if (!gcdFirst && !gcdTried) {
      gcdTried = true;
      const gcd = await linkGcd();
      if (gcd.ok) return finish(gcd.message);
      reason = gcd.reason || reason;
    }
  } catch (error) {
    if (error instanceof GcdBudgetError) {
      await pauseForGcd(error);
      throw error;
    }
    throw error;
  }

  if (needsCredentials) {
    return { ok: false, message: "Set Metron username and password in Settings or the environment.", outcome: "unmatched" };
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

export async function rematchAllSuspectCopies(): Promise<{ ok: boolean; message: string }> {
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
  for (const comic of comics) {
    const reason = suspectMatchReason({ ...comic, catalogStoreYear: years[comic.id] ?? null, catalogPrinting: printings[comic.id] ?? null });
    if (!reason) continue;
    const link = readManualLink(comic.manualLink);
    if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId || link.userCover) {
      skipped += 1;
      continue;
    }
    try {
      const result = await rematchShelfCopy(comic.id, { metron });
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
        metron = false;
        continue;
      }
      if (error instanceof GcdBudgetError) {
        return { ok: false, message: `${error.message} Re-matched ${matched} before stopping.` };
      }
      unmatched += 1;
    }
  }
  const message = `Re-matched ${matched}. Left ${unmatched} unmatched. Skipped ${skipped} hand-picked links.`;
  await writeLog({ level: "info", source: "covers/backfill", message, details: { matched, unmatched, skipped } });
  return { ok: true, message };
}

async function runStoredFacsimileRematch(): Promise<boolean> {
  if (!(await metronBasicAuth())) return false;
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
    already: async () => {
      const row = await prisma.appSetting.findUnique({ where: { key: FACSIMILE_REMATCH_KEY } });
      return row?.plain === "done";
    },
    markDone: async () => {
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
      try {
        const result = await rematchShelfCopy(id, { metron: ctx?.metron !== false });
        return result.outcome;
      } catch (error) {
        if (error instanceof MetronBudgetError) {
          await closeMetron(error);
          return "deferred";
        }
        if (error instanceof GcdBudgetError) return "stopped";
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
        message: `Edition re-match finished. Matched ${summary.matched}. Unmatched ${summary.unmatched}. Skipped ${summary.skipped} hand-picked links.`,
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
