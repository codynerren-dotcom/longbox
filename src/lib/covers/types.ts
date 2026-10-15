export type MetronIssueHit = {
  id: string;
  seriesId: string | null;
  seriesName: string;
  number: string;
  coverYear: number | null;
  imageUrl: string | null;
  label: string | null;
  releaseYear?: number | null;
  seriesYear?: number | null;
  upc?: string | null;
  publisher?: string | null;
  variant?: string | null;
  cvId?: string | null;
  gcdId?: string | null;
  /** ISO day from the catalog store or on-sale date. */
  storeDate?: string | null;
  covers?: Array<{ label: string; imageUrl: string }>;
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
  title?: string | null;
  fullTitle?: string | null;
  variantDescription?: string | null;
  format?: string | null;
  subtitle?: string | null;
  releaseYear?: number | null;
  releaseDate?: Date | string | null;
  seriesYear?: number | null;
  coverPrice?: unknown;
  /** Store or cover year of the issue this copy is already linked to. */
  catalogStoreYear?: number | null;
};

export type CoverDecision =
  | {
      status: "matched";
      via: "barcode" | "series" | "gcd";
      issue: MetronIssueHit;
      score: number;
      /** Set when the issue is linked and the 1st-print cover must not be saved. */
      coverReview?: string | null;
    }
  | { status: "unmatched"; reason: string; score: number };

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
  /** Set when this copy is already linked on GCD. Backfill does not search again. */
  gcdIssueId?: string | null;
  manualGcdIssueId?: string | null;
  /** Comic Vine issue id already stored on the copy. Used to ask Metron for the same issue. */
  comicvineIssueId?: string | null;
  /** Metron issue id carried on a GCD record, when that catalog sends one. */
  embeddedMetronIssueId?: string | null;
};

export class MetronBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetronBudgetError";
  }
}
