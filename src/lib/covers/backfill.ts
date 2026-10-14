import { resolveCover } from "@/lib/covers/match";
import { MetronBudgetError, type CoverLookup, type CoverRecord, type MetronIssueHit } from "@/lib/covers/types";

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
  if (comic.coverStatus === "unmatched") return false;
  if (comic.coverFile && fileExists(comic.coverFile)) return false;
  return true;
}

export async function backfillCovers(args: {
  comics: CoverRecord[];
  lookup: CoverLookup;
  fileExists: (filename: string) => boolean;
  saveImage: (issue: MetronIssueHit) => Promise<string>;
  markMatched: (id: string, update: { metronIssueId: string; coverFile: string; coverUrl: string }) => Promise<void>;
  markUnmatched: (id: string, reason: string) => Promise<void>;
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
    try {
      const decision = await resolveCover(comic, args.lookup);
      if (decision.status === "matched") {
        let filename: string;
        try {
          filename = await args.saveImage(decision.issue);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Could not download the Metron cover.";
          await args.markUnmatched(comic.id, reason);
          summary.unmatched += 1;
          args.log?.(`${comic.series} #${issueNo} unmatched: ${reason}`);
          args.onProgress?.(summary);
          continue;
        }
        await args.markMatched(comic.id, {
          metronIssueId: decision.issue.id,
          coverFile: filename,
          coverUrl: coverPublicPath(filename),
        });
        summary.matched += 1;
        args.log?.(`${comic.series} #${issueNo} matched Metron ${decision.issue.id} via ${decision.via}`);
      } else {
        await args.markUnmatched(comic.id, decision.reason);
        summary.unmatched += 1;
        args.log?.(`${comic.series} #${issueNo} unmatched: ${decision.reason}`);
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
