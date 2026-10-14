export type MetronIssueHit = {
  id: string;
  seriesId: string | null;
  seriesName: string;
  number: string;
  coverYear: number | null;
  imageUrl: string | null;
  label: string | null;
};

export type MetronSeriesHit = {
  id: string;
  name: string;
  yearBegan: number | null;
  yearEnd: number | null;
  publisher: string | null;
};

export type CoverLookup = {
  issuesByUpc: (upc: string) => Promise<MetronIssueHit[]>;
  issuesByUpcPrefix: (upc: string) => Promise<MetronIssueHit[]>;
  searchSeries: (name: string) => Promise<MetronSeriesHit[]>;
  issuesForSeries: (seriesId: string, number: string, coverYear: number | null) => Promise<MetronIssueHit[]>;
};

export type CoverQuery = {
  series: string;
  issueNo: string | null;
  issue: string | null;
  coverYear: number | null;
  barcode: string | null;
  variant: string | null;
  publisher: string | null;
};

export type CoverDecision =
  | { status: "matched"; via: "barcode" | "series"; issue: MetronIssueHit }
  | { status: "unmatched"; reason: string };

export type CoverRecord = CoverQuery & {
  id: string;
  coverFile: string | null;
  coverStatus: string | null;
  metronIssueId: string | null;
  /** Set when a person linked this Metron issue. Backfill must not search for a different one. */
  manualMetronIssueId?: string | null;
  manualCoverImageUrl?: string | null;
  /** A photo uploaded on the issue. Backfill must not replace it, even when the file is missing. */
  userCover?: boolean;
};

export class MetronBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetronBudgetError";
  }
}
