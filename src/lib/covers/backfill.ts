import { GcdBudgetError } from "@/lib/catalog/gcd";
import { crossLinkLine, lookupCrossIssue, type CrossLookup } from "@/lib/covers/cross-link";
import { detectEdition } from "@/lib/covers/edition";
import type { MetronDetails } from "@/lib/covers/enrich";
import { coverFileKey } from "@/lib/covers/files";
import { resolveCover, savedPrintingCover } from "@/lib/covers/match";
import { MetronBudgetError, type CoverDecision, type CoverLookup, type CoverRecord, type MetronIssueHit } from "@/lib/covers/types";

export type BackfillSummary = {
  pending: number;
  matched: number;
  unmatched: number;
  skipped: number;
  stoppedReason: string | null;
};

export function coverPublicPath(filename: string): string {
  return `/covers/files/${filename}`;
}

export function needsCover(comic: CoverRecord, fileExists: (filename: string) => boolean): boolean {
  if (comic.userCover || comic.coverStatus === "manual") return false;
  if (comic.coverStatus === "unmatched" || comic.coverStatus === "gcd") return false;
  if (comic.gcdIssueId || comic.manualGcdIssueId) return false;
  if (comic.coverFile && fileExists(comic.coverFile)) return false;
  return true;
}

export async function backfillCovers(args: {
  comics: CoverRecord[];
  lookup: CoverLookup;
  fileExists: (filename: string) => boolean;
  saveImage: (issue: MetronIssueHit) => Promise<string>;
  loadDetail?: (issueId: string) => Promise<MetronDetails | null>;
  /** Always reads the linked issue, including when detail fill is off, so a missing cover can be saved. */
  loadIssue?: (issueId: string) => Promise<MetronDetails | null>;
  markMatched: (
    id: string,
    update: { metronIssueId: string; coverFile: string | null; coverUrl: string | null; coverNote?: string | null; printing?: number | null },
    detail: MetronDetails | null,
  ) => Promise<void>;
  markUnmatched: (id: string, reason: string) => Promise<void>;
  gcd?: (comic: CoverRecord) => Promise<CoverDecision>;
  markGcd?: (
    id: string,
    update: { gcdIssueId: string; gcdSeriesId: string | null; score: number; coverReview?: string | null; printing?: number | null },
  ) => Promise<void>;
  /** Comic Vine id and GCD id lookups on Metron. An exact hit is linked before a name search. */
  crossLookup?: CrossLookup;
  log?: (line: string) => void;
  onProgress?: (summary: BackfillSummary) => void;
  shouldPause?: () => Promise<boolean> | boolean;
}): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    pending: args.comics.filter((comic) => needsCover(comic, args.fileExists)).length,
    matched: 0,
    unmatched: 0,
    skipped: 0,
    stoppedReason: null,
  };

  let gcdOpen = Boolean(args.gcd && args.markGcd);
  for (const comic of args.comics) {
    if (await args.shouldPause?.()) {
      summary.stoppedReason = "Paused.";
      args.log?.("Paused.");
      args.onProgress?.(summary);
      break;
    }
    if (!needsCover(comic, args.fileExists)) {
      summary.skipped += 1;
      continue;
    }
    const issueNo = comic.issueNo || comic.issue || "?";
    const lockedMetronId = comic.manualMetronIssueId?.trim() || "";
    if (lockedMetronId) {
      try {
        let imageUrl = comic.manualCoverImageUrl?.trim() || "";
        let detail: MetronDetails | null = null;
        if (!imageUrl && args.loadIssue) {
          detail = await args.loadIssue(lockedMetronId);
          imageUrl = detail?.imageUrl ?? "";
        }
        if (!imageUrl) {
          summary.skipped += 1;
          args.log?.(`${comic.series} #${issueNo} kept manual Metron ${lockedMetronId}; no cover image.`);
          args.onProgress?.(summary);
          continue;
        }
        const filename = await args.saveImage({
          id: coverFileKey(lockedMetronId, imageUrl, detail?.imageUrl ?? null),
          seriesId: detail?.seriesId ?? null,
          seriesName: comic.series,
          number: issueNo,
          coverYear: comic.coverYear,
          imageUrl,
          label: null,
        });
        if (args.loadDetail) {
          try {
            detail = (await args.loadDetail(lockedMetronId)) ?? detail;
          } catch (error) {
            if (error instanceof MetronBudgetError) throw error;
            detail = null;
          }
        }
        await args.markMatched(
          comic.id,
          { metronIssueId: lockedMetronId, coverFile: filename, coverUrl: coverPublicPath(filename) },
          detail,
        );
        summary.matched += 1;
        args.log?.(`${comic.series} #${issueNo} kept manual Metron ${lockedMetronId}.`);
        args.onProgress?.(summary);
      } catch (error) {
        if (error instanceof MetronBudgetError) {
          summary.stoppedReason = error.message;
          args.log?.(summary.stoppedReason);
          args.onProgress?.(summary);
          break;
        }
        const reason = error instanceof Error ? error.message : "Could not download the linked cover.";
        summary.skipped += 1;
        args.log?.(`${comic.series} #${issueNo} kept manual Metron ${lockedMetronId}; ${reason}`);
        args.onProgress?.(summary);
      }
      continue;
    }
    const storedMetronId = comic.metronIssueId?.trim() || "";
    if (storedMetronId) {
      try {
        const detail = args.loadIssue ? await args.loadIssue(storedMetronId) : null;
        const printing = savedPrintingCover(
          comic,
          {
            id: storedMetronId,
            seriesId: detail?.seriesId ?? null,
            seriesName: detail?.seriesName || comic.series,
            number: detail?.number || issueNo,
            coverYear: detail?.coverYear ?? comic.coverYear,
            imageUrl: null,
            label: null,
            covers: detail?.covers ?? [],
          },
        );
        if (printing.active) {
          if (!printing.imageUrl) {
            await args.markMatched(
              comic.id,
              { metronIssueId: storedMetronId, coverFile: null, coverUrl: null, coverNote: printing.note, printing: null },
              detail,
            );
            summary.matched += 1;
            args.log?.(`${comic.series} #${issueNo} kept Metron ${storedMetronId}. ${printing.note ?? ""}`.trim());
            args.onProgress?.(summary);
            continue;
          }
          const filename = await args.saveImage({
            id: coverFileKey(storedMetronId, printing.imageUrl, null),
            seriesId: detail?.seriesId ?? null,
            seriesName: comic.series,
            number: issueNo,
            coverYear: comic.coverYear,
            imageUrl: printing.imageUrl,
            label: printing.note,
          });
          await args.markMatched(
            comic.id,
            {
              metronIssueId: storedMetronId,
              coverFile: filename,
              coverUrl: coverPublicPath(filename),
              coverNote: null,
              printing: printing.printing,
            },
            detail,
          );
          summary.matched += 1;
          args.log?.(`${comic.series} #${issueNo} kept Metron ${storedMetronId}.`);
          args.onProgress?.(summary);
          continue;
        }
        const imageUrl = detail?.imageUrl || "";
        if (!imageUrl) {
          summary.skipped += 1;
          args.log?.(`${comic.series} #${issueNo} kept Metron ${storedMetronId}; no cover image.`);
          args.onProgress?.(summary);
          continue;
        }
        const filename = await args.saveImage({
          id: coverFileKey(storedMetronId, imageUrl, detail?.imageUrl ?? null),
          seriesId: detail?.seriesId ?? null,
          seriesName: comic.series,
          number: issueNo,
          coverYear: comic.coverYear,
          imageUrl,
          label: null,
        });
        await args.markMatched(
          comic.id,
          { metronIssueId: storedMetronId, coverFile: filename, coverUrl: coverPublicPath(filename) },
          detail,
        );
        summary.matched += 1;
        args.log?.(`${comic.series} #${issueNo} kept Metron ${storedMetronId}.`);
        args.onProgress?.(summary);
      } catch (error) {
        if (error instanceof MetronBudgetError) {
          summary.stoppedReason = error.message;
          args.log?.(summary.stoppedReason);
          args.onProgress?.(summary);
          break;
        }
        const reason = error instanceof Error ? error.message : "Could not download the linked cover.";
        summary.skipped += 1;
        args.log?.(`${comic.series} #${issueNo} kept Metron ${storedMetronId}; ${reason}`);
        args.onProgress?.(summary);
      }
      continue;
    }
    try {
      const editionKind = detectEdition(comic).kind;
      if (args.crossLookup && editionKind !== "facsimile" && editionKind !== "printing" && (comic.comicvineIssueId || comic.gcdIssueId || comic.embeddedMetronIssueId)) {
        const cross = await lookupCrossIssue(
          {
            id: comic.id,
            series: comic.series,
            issueNo: comic.issueNo,
            issue: comic.issue,
            metronIssueId: comic.metronIssueId,
            manualMetronIssueId: comic.manualMetronIssueId,
            comicvineIssueId: comic.comicvineIssueId,
            gcdIssueId: comic.gcdIssueId,
            embeddedMetronIssueId: comic.embeddedMetronIssueId,
            userCover: comic.userCover,
            coverFile: comic.coverFile,
            coverStatus: comic.coverStatus,
          },
          args.crossLookup,
        );
        const line = crossLinkLine(
          { id: comic.id, series: comic.series, issueNo: comic.issueNo, issue: comic.issue, metronIssueId: comic.metronIssueId },
          cross,
        );
        if (cross.status === "many") {
          await args.markUnmatched(comic.id, cross.reason);
          summary.unmatched += 1;
          if (line) args.log?.(line);
          args.onProgress?.(summary);
          continue;
        }
        if (cross.status === "linked") {
          let detail: MetronDetails | null = null;
          if (args.loadDetail) detail = await args.loadDetail(cross.hit.id);
          const metronIssueId = detail?.id || cross.hit.id;
          const imageUrl = detail?.imageUrl || cross.hit.imageUrl;
          if (!imageUrl) {
            await args.markUnmatched(comic.id, `Metron issue ${metronIssueId} has no cover image.`);
            summary.unmatched += 1;
            args.log?.(`${comic.series} #${issueNo} unmatched: Metron issue ${metronIssueId} has no cover image.`);
            args.onProgress?.(summary);
            continue;
          }
          let filename: string;
          try {
            filename = await args.saveImage({ ...cross.hit, id: metronIssueId, imageUrl });
          } catch (error) {
            if (error instanceof MetronBudgetError) throw error;
            const reason = error instanceof Error ? error.message : "Could not download the Metron cover.";
            await args.markUnmatched(comic.id, reason);
            summary.unmatched += 1;
            args.log?.(`${comic.series} #${issueNo} unmatched: ${reason}`);
            args.onProgress?.(summary);
            continue;
          }
          await args.markMatched(
            comic.id,
            { metronIssueId, coverFile: filename, coverUrl: coverPublicPath(filename) },
            detail,
          );
          summary.matched += 1;
          if (line) args.log?.(line);
          args.onProgress?.(summary);
          continue;
        }
        if (line) args.log?.(line);
      }
      const decision = await resolveCover(comic, args.lookup);
      if (decision.status === "matched") {
        let detail: MetronDetails | null = null;
        if (args.loadDetail) detail = await args.loadDetail(decision.issue.id);
        const metronIssueId = detail?.id || decision.issue.id;
        const printing = savedPrintingCover(comic, decision.issue, detail?.covers);
        const imageUrl = printing.active ? printing.imageUrl : detail?.imageUrl || decision.issue.imageUrl;
        if (printing.active && !imageUrl) {
          await args.markMatched(
            comic.id,
            { metronIssueId, coverFile: null, coverUrl: null, coverNote: printing.note, printing: null },
            detail,
          );
          summary.matched += 1;
          args.log?.(`${comic.series} #${issueNo} matched Metron ${decision.issue.id} via ${decision.via}, score ${decision.score}. ${printing.note ?? ""}`.trim());
          args.onProgress?.(summary);
          continue;
        }
        let filename: string;
        try {
          if (!imageUrl) throw new Error(`Metron issue ${metronIssueId} has no cover image.`);
          filename = await args.saveImage({ ...decision.issue, id: metronIssueId, imageUrl });
        } catch (error) {
          if (printing.active) {
            const reason = error instanceof Error ? error.message : "Could not download the printing cover.";
            await args.markMatched(
              comic.id,
              { metronIssueId, coverFile: null, coverUrl: null, coverNote: reason, printing: null },
              detail,
            );
            summary.matched += 1;
            args.log?.(`${comic.series} #${issueNo} matched Metron ${decision.issue.id} via ${decision.via}, score ${decision.score}. ${reason}`);
            args.onProgress?.(summary);
            continue;
          }
          const reason = error instanceof Error ? error.message : "Could not download the Metron cover.";
          await args.markUnmatched(comic.id, reason);
          summary.unmatched += 1;
          args.log?.(`${comic.series} #${issueNo} unmatched: ${reason}`);
          args.onProgress?.(summary);
          continue;
        }
        await args.markMatched(
          comic.id,
          {
            metronIssueId,
            coverFile: filename,
            coverUrl: coverPublicPath(filename),
            ...(printing.active ? { coverNote: null, printing: printing.printing } : {}),
          },
          detail,
        );
        summary.matched += 1;
        args.log?.(`${comic.series} #${issueNo} matched Metron ${decision.issue.id} via ${decision.via}, score ${decision.score}.`);
      } else {
        const gcdDecision = await tryGcd(gcdOpen, args.gcd, comic);
        if (gcdDecision === "budget") {
          gcdOpen = false;
          args.log?.("GCD rate limit reached. Later copies will stay unmatched.");
        }
        if (gcdDecision && gcdDecision !== "budget" && gcdDecision.status === "matched" && args.markGcd) {
          const printingEdition = detectEdition(comic);
          const confirmedPrinting = printingEdition.kind === "printing" && printingEdition.printing != null && !gcdDecision.coverReview;
          await args.markGcd(comic.id, {
            gcdIssueId: gcdDecision.issue.id,
            gcdSeriesId: gcdDecision.issue.seriesId,
            score: gcdDecision.score,
            coverReview: gcdDecision.coverReview ?? null,
            printing: printingEdition.kind === "printing" ? (confirmedPrinting ? printingEdition.printing : null) : undefined,
          });
          summary.matched += 1;
          args.log?.(`${comic.series} #${issueNo} matched GCD ${gcdDecision.issue.id}, score ${gcdDecision.score}. Cover stays on GCD.`);
        } else {
          const gcdReason = gcdDecision && gcdDecision !== "budget" && gcdDecision.status === "unmatched" ? ` ${gcdDecision.reason}` : "";
          const reason = `${decision.reason}${gcdReason}`;
          await args.markUnmatched(comic.id, reason);
          summary.unmatched += 1;
          args.log?.(`${comic.series} #${issueNo} unmatched: ${reason}`);
        }
      }
      args.onProgress?.(summary);
    } catch (error) {
      summary.stoppedReason = error instanceof MetronBudgetError || error instanceof Error ? error.message : "Cover backfill stopped.";
      args.log?.(summary.stoppedReason);
      args.onProgress?.(summary);
      break;
    }
  }

  return summary;
}

async function tryGcd(
  open: boolean,
  gcd: ((comic: CoverRecord) => Promise<CoverDecision>) | undefined,
  comic: CoverRecord,
): Promise<CoverDecision | "budget" | null> {
  if (!open || !gcd) return null;
  try {
    return await gcd(comic);
  } catch (error) {
    if (error instanceof GcdBudgetError) return "budget";
    return { status: "unmatched", reason: error instanceof Error ? error.message : "GCD lookup failed.", score: 0 };
  }
}
