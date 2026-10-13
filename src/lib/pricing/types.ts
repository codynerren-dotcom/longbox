export type PriceQuery = {
  series: string;
  issueNo: string | null;
  publisher: string | null;
  barcode: string | null;
  grade: string | null;
};

export type PriceQuote = {
  source: string;
  amount: number | null;
  currency: "USD";
  url?: string;
  fetchedAt: string;
  /** `unconfigured` when credentials are missing, `not_implemented` until the provider ships. */
  status: "unconfigured" | "not_implemented" | "ok";
};

/**
 * Live price source. v1 ships the contract and an eBay stub only.
 * Do not add PriceCharting. Quotes should be stored in `price_snapshots`.
 */
export interface PriceProvider {
  readonly id: string;
  isConfigured(): Promise<boolean>;
  quote(comic: PriceQuery): Promise<PriceQuote>;
}
