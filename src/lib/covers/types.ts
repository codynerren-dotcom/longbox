export type MetronIssueHit = {
  id: string;
  seriesId: string | null;
  seriesName: string;
  number: string;
  /** Legacy numbering, such as Captain America #783 on relaunch #13. */
  altNumber?: string | null;
  coverYear: number | null;
  imageUrl: string | null;
  label: string | null;
  releaseYear?: number | null;
  seriesYear?: number | null;
  /** Metron series volume. Used to pick Vol. 8 over an older series with the same name. */
  seriesVolume?: number | null;
  upc?: string | null;
  /** Other UPC strings from the issue detail, including variant covers. The list payload leaves these off. */
  upcs?: string[] | null;
  publisher?: string | null;
  variant?: string | null;
  cvId?: string | null;
  gcdId?: string | null;
  /** ISO day from the catalog store or on-sale date. */
  storeDate?: string | null;
  covers?: Array<{ label: string; imageUrl: string; upc?: string | null }>;
  /** True when this hit was loaded from `/api/issue/{id}/` during a barcode tie-break. */
  detailFetched?: boolean;
  /** Series `issue_count` when the search that found this issue knows it. */
  oneIssue?: boolean;
};

export type MetronSeriesHit = {
  id: string;
  name: string;
  yearBegan: number | null;
  yearEnd: number | null;
  /** Metron series volume. Absent on older payloads. */
  volume?: number | null;
  publisher: string | null;
  /** Present when the series payload includes `issue_count`. */
  issueCount?: number | null;
  /** Metron series type, such as Trade Paperback or Limited Series. */
  seriesType?: string | null;
};

export type MetronSeriesQuery = {
  volume?: number | null;
  yearBegan?: number | null;
};

export type CoverLookup = {
  issuesByUpc: (upc: string) => Promise<MetronIssueHit[]>;
  issuesByUpcPrefix: (upc: string) => Promise<MetronIssueHit[]>;
  searchSeries: (name: string, query?: MetronSeriesQuery) => Promise<MetronSeriesHit[]>;
  issuesForSeries: (seriesId: string, number: string, coverYear: number | null) => Promise<MetronIssueHit[]>;
  /** ISBN-13 lookup. Optional so older test lookups still typecheck. */
  issuesByIsbn?: (isbn: string) => Promise<MetronIssueHit[]>;
  /** Series search limited to a Metron series type such as Trade Paperback. */
  searchSeriesByType?: (name: string, seriesType: string) => Promise<MetronSeriesHit[]>;
  /**
   * One list request: `series_name`, `number`, and `series_year_began` or `volume`.
   * A miss on a legacy number retries `alt_number`. A miss with no year retries `series_q`.
   * Present on the live client. Test lookups that still search series by name omit it.
   */
  issuesByName?: (seriesName: string, number: string, seriesYearBegan: number | null, volume?: number | null) => Promise<MetronIssueHit[]>;
};

export type CoverQuery = {
  series: string;
  issueNo: string | null;
  issue: string | null;
  coverYear: number | null;
  barcode: string | null;
  /** ISBN-13 when the copy has one separate from the UPC. */
  isbn?: string | null;
  variant: string | null;
  publisher: string | null;
  title?: string | null;
  fullTitle?: string | null;
  variantDescription?: string | null;
  format?: string | null;
  shelfFormat?: string | null;
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

export type BudgetPause = {
  budget: string;
  count: number | null;
  resumeAt: number;
};

/** A fetch that never got an HTTP response: timeout, reset, or DNS. Not a 4xx. */
export class MetronConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MetronConnectError";
  }
}

export class MetronBudgetError extends Error {
  readonly pause: BudgetPause;

  constructor(message: string, pause?: Partial<BudgetPause>) {
    super(message);
    this.name = "MetronBudgetError";
    this.pause = {
      budget: pause?.budget ?? "Metron daily",
      count: pause?.count ?? null,
      resumeAt: pause?.resumeAt ?? 0,
    };
  }
}
