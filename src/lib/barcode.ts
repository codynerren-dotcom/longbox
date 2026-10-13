export type ParsedBarcode = {
  raw: string;
  /** Digits only, leading zeros preserved. */
  digits: string;
  /** UPC-A (12) or EAN-13 (13) when the scan includes a primary code. */
  upc: string | null;
  /** 2-digit or 5-digit add-on. Comic UPC-A add-ons are 5 digits. */
  addon: string | null;
  /** Primary code plus add-on, with no separator. */
  combined: string;
};

/**
 * Parse a comic barcode without ever coercing it through Number().
 * Accepts 12-digit UPC-A, 17-digit UPC-A + 5-digit add-on, and the same
 * shapes with spaces or dashes. Leading zeros stay put.
 */
export function parseComicBarcode(input: string): ParsedBarcode | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  if (/[eE][+\-]?\d+/.test(raw)) return null;

  const compact = raw.replace(/[\s-]+/g, "");
  if (!/^\d+$/.test(compact)) return null;

  if (compact.length === 12 || compact.length === 13) {
    return { raw, digits: compact, upc: compact, addon: null, combined: compact };
  }
  if (compact.length === 14 || compact.length === 17) {
    const addonLength = compact.length === 14 ? 2 : 5;
    const upc = compact.slice(0, compact.length - addonLength);
    const addon = compact.slice(compact.length - addonLength);
    return { raw, digits: compact, upc, addon, combined: compact };
  }
  if (compact.length === 18) {
    return {
      raw,
      digits: compact,
      upc: compact.slice(0, 13),
      addon: compact.slice(13),
      combined: compact,
    };
  }
  return null;
}

/** Combine a UPC-A read and a separate 5-digit add-on from the same camera frame. */
export function mergeDetectedCodes(codes: string[]): ParsedBarcode | null {
  const parsed = codes
    .map((code) => parseComicBarcode(code))
    .filter((code): code is ParsedBarcode => code !== null);

  const withAddon = parsed.find((code) => code.addon && code.addon.length === 5);
  if (withAddon) return withAddon;

  const primary = parsed.find((code) => code.upc && (code.upc.length === 12 || code.upc.length === 13) && !code.addon);
  const addon = codes
    .map((code) => code.trim())
    .find((code) => /^\d{5}$/.test(code) || /^\d{2}$/.test(code));

  if (primary && addon) {
    return parseComicBarcode(`${primary.upc}${addon}`);
  }
  return primary ?? null;
}

export function barcodeLookupKeys(parsed: ParsedBarcode): string[] {
  const keys = [parsed.combined];
  if (parsed.upc && parsed.upc !== parsed.combined) keys.push(parsed.upc);
  return keys;
}
