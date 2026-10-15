import { createGcdCatalog, GcdBudgetError } from "@/lib/catalog/gcd";
import { readManualLink } from "@/lib/catalog/manual-link";
import { coverPublicPath } from "@/lib/covers/backfill";
import { calendarDay, detectEdition, suspectMatchReason } from "@/lib/covers/edition";
import { METRON_FIELDS, readFieldSources } from "@/lib/covers/enrich";
import { coversDir, downloadCover } from "@/lib/covers/files";
import { resolveGcdCover } from "@/lib/covers/gcd-match";
import { resolveCover, savedPrintingCover } from "@/lib/covers/match";
import { createMetronCoverLookup, fetchMetronIssueRecord, metronBasicAuth, metronTransport } from "@/lib/covers/metron-client";
import { runFacsimilePass, type RematchOutcome } from "@/lib/covers/facsimile-once";
import { FACSIMILE_REMATCH_KEY, readCatalogYears, readPrintingCovers, writeCatalogYear, writePrintingCover } from "@/lib/covers/facsimile-years";
import { applyEnrichment, applyGcdLink } from "@/lib/covers/run";
import { MetronBudgetError, type CoverQuery, type MetronIssueHit } from "@/lib/covers/types";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import type { Prisma } from "@prisma/client";

let inflight: Promise<void> | null = null;
let finishedForProcess = false;
let nextAttemptAt = 0;

export function scheduleFacsimileRematch(): void {
  if (process.env.VITEST || process.env.NEXT_PHASE === "phase-production-build") return;
  if (finishedForProcess || inflight || Date.now() < nextAttemptAt) return;
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

async function clearAutomaticLink(comicId: string, reason: string): Promise<void> {
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
    coverFile: null,
    coverUrl: null,
    coverStatus: "unmatched",
    coverNote: reason,
    coverCheckedAt: new Date(),
    fieldSources: sources,
  };
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

export async function rematchShelfCopy(comicId: string): Promise<{ ok: boolean; message: string }> {
  const comic = await prisma.comic.findUnique({ where: { id: comicId } });
  if (!comic) return { ok: false, message: "That issue is not on the shelf." };
  const link = readManualLink(comic.manualLink);
  if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId) {
    return { ok: false, message: "This link was chosen by hand. Unlink it first." };
  }
  if (link.userCover) {
    return { ok: false, message: "This cover was uploaded. Unlink the catalog id if you want, and the photo stays." };
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

  if (metronReady) {
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
      await clearAutomaticLink(comicId, "Re-matching.");
      await applyEnrichment(comicId, detail, {
        metronIssueId: decision.issue.id,
        metronSeriesId: decision.issue.seriesId,
        coverFile: filename,
        coverUrl: filename ? coverPublicPath(filename) : null,
        coverStatus: filename ? "matched" : null,
        coverNote: filename ? null : note,
        coverCheckedAt: new Date(),
      });
      const year = catalogYear(decision.issue) ?? (detail?.releaseDate ? detail.releaseDate.getUTCFullYear() : null);
      await writeCatalogYear(comicId, year);
      if (printing.active) await writePrintingCover(comicId, filename ? printing.printing : null);
      const review = filename ? "" : note ? ` ${note}` : "";
      const message = `Matched Metron ${decision.issue.id} (${decision.issue.seriesName} #${decision.issue.number}), score ${decision.score}.${review}`;
      await writeLog({ level: "info", source: "covers/backfill", message, details: { comicId, metronIssueId: decision.issue.id, score: decision.score } });
      return { ok: true, message };
    }
    reason = decision.reason;
  }

  const gcd = await resolveGcdCover(query, createGcdCatalog());
  if (gcd.status === "matched") {
    const { gcdDetails } = await import("@/lib/covers/gcd-match");
    const issue = await createGcdCatalog().issue(gcd.issue.id);
    const detail = issue ? gcdDetails(issue) : null;
    await clearAutomaticLink(comicId, "Re-matching.");
    const confirmedPrinting = edition.kind === "printing" && edition.printing != null && !gcd.coverReview;
    await applyGcdLink(comicId, gcd.issue.id, gcd.issue.seriesId, gcd.score, detail, {
      coverReview: gcd.coverReview ?? null,
      printing: edition.kind === "printing" ? (confirmedPrinting ? edition.printing : null) : undefined,
    });
    await writeCatalogYear(comicId, catalogYear(gcd.issue));
    const review = gcd.coverReview ? ` ${gcd.coverReview}` : "";
    const message = `Matched GCD ${gcd.issue.id} (${gcd.issue.seriesName} #${gcd.issue.number}), score ${gcd.score}.${review}`;
    await writeLog({ level: "info", source: "covers/backfill", message, details: { comicId, gcdIssueId: gcd.issue.id, score: gcd.score } });
    return { ok: true, message };
  }

  if (!metronReady) {
    return { ok: false, message: "Set Metron username and password in Settings or the environment." };
  }
  reason = gcd.reason || reason;
  await clearAutomaticLink(comicId, reason);
  await writeLog({ level: "info", source: "covers/backfill", message: reason, details: { comicId } });
  return { ok: true, message: reason };
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
  for (const comic of comics) {
    const reason = suspectMatchReason({ ...comic, catalogStoreYear: years[comic.id] ?? null, catalogPrinting: printings[comic.id] ?? null });
    if (!reason) continue;
    const link = readManualLink(comic.manualLink);
    if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId || link.userCover) {
      skipped += 1;
      continue;
    }
    try {
      const result = await rematchShelfCopy(comic.id);
      if (result.message.startsWith("Matched")) matched += 1;
      else unmatched += 1;
    } catch (error) {
      if (error instanceof MetronBudgetError || error instanceof GcdBudgetError) {
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
    rematch: async (id) => {
      try {
        const result = await rematchShelfCopy(id);
        return (result.message.startsWith("Matched") ? "matched" : "unmatched") as RematchOutcome;
      } catch (error) {
        if (error instanceof MetronBudgetError || error instanceof GcdBudgetError) return "stopped";
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
  if (summary.done && (summary.matched > 0 || summary.unmatched > 0 || summary.skipped > 0)) {
    await writeLog({
      level: "info",
      source: "covers/backfill",
      message: `Edition re-match finished. Matched ${summary.matched}. Unmatched ${summary.unmatched}. Skipped ${summary.skipped} hand-picked links.`,
      details: summary,
    });
  }
  return summary.done;
}
