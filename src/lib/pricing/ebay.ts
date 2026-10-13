import type { PriceProvider, PriceQuery, PriceQuote } from "@/lib/pricing/types";

/**
 * eBay Browse/Finding API stub. Credentials are read from the environment and
 * never logged. The quote is intentionally empty until the pricing milestone.
 */
export class EbayPriceProvider implements PriceProvider {
  readonly id = "ebay";

  isConfigured(): boolean {
    return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
  }

  async quote(_comic: PriceQuery): Promise<PriceQuote> {
    return {
      source: this.id,
      amount: null,
      currency: "USD",
      fetchedAt: new Date().toISOString(),
      status: this.isConfigured() ? "not_implemented" : "unconfigured",
    };
  }
}

export function getPriceProvider(): PriceProvider {
  return new EbayPriceProvider();
}
