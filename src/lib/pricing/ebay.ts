import type { PriceProvider, PriceQuery, PriceQuote } from "@/lib/pricing/types";
import { getPreferences, getSettings } from "@/lib/settings/service";
import { probeEbay, type ProbeResult } from "@/lib/settings/probe";
import type { IntegrationConfig } from "@/lib/settings/resolve";

/**
 * eBay Browse/Finding API stub. Credentials come from Settings, then the environment.
 * The quote is intentionally empty until the pricing milestone.
 */
export class EbayPriceProvider implements PriceProvider {
  readonly id = "ebay";

  async isConfigured(): Promise<boolean> {
    const [settings, prefs] = await Promise.all([getSettings(), getPreferences()]);
    return settings.ebay.configured && prefs.pricing.enabled;
  }

  async quote(_comic: PriceQuery): Promise<PriceQuote> {
    const [settings, prefs] = await Promise.all([getSettings(), getPreferences()]);
    const currency = prefs.pricing.currency;
    if (!prefs.pricing.enabled) {
      return { source: this.id, amount: null, currency, fetchedAt: new Date().toISOString(), status: "disabled" };
    }
    return {
      source: this.id,
      amount: null,
      currency,
      fetchedAt: new Date().toISOString(),
      status: settings.ebay.configured ? "not_implemented" : "unconfigured",
    };
  }
}

export function testEbayConnection(config: IntegrationConfig, fetchImpl?: typeof fetch): Promise<ProbeResult> {
  return probeEbay(config, fetchImpl);
}

export async function testEbayFromSettings(fetchImpl?: typeof fetch): Promise<ProbeResult> {
  return probeEbay(await getSettings(), fetchImpl);
}

export function getPriceProvider(): PriceProvider {
  return new EbayPriceProvider();
}
