import { describe, expect, it } from "vitest";
import { mergeDetectedCodes, parseComicBarcode } from "@/lib/barcode";

describe("comic barcodes", () => {
  it("keeps a 17-digit UPC-A plus 5-digit add-on as a string", () => {
    const parsed = parseComicBarcode("07596060000100001");
    expect(parsed).toEqual({
      raw: "07596060000100001",
      digits: "07596060000100001",
      upc: "075960600001",
      addon: "00001",
      combined: "07596060000100001",
    });
    expect(String(Number("07596060000100001"))).not.toBe(parsed?.combined);
  });

  it("accepts spaces, dashes, a bare UPC-A, and a separate add-on", () => {
    expect(parseComicBarcode("075960600002 00002")?.combined).toBe("07596060000200002");
    expect(parseComicBarcode("075960600002-00002")?.addon).toBe("00002");
    expect(parseComicBarcode("075960600001")?.combined).toBe("075960600001");
    expect(parseComicBarcode("075960600001")?.addon).toBeNull();
    expect(mergeDetectedCodes(["075960600003", "00003"])?.combined).toBe("07596060000300003");
  });

  it("rejects values that would have to be coerced through a number", () => {
    expect(parseComicBarcode("")).toBeNull();
    expect(parseComicBarcode("not a barcode")).toBeNull();
    expect(parseComicBarcode("7.59606095582e+16")).toBeNull();
    expect(parseComicBarcode("12345")).toBeNull();
  });

  it("never drops leading zeros on a 12-digit code", () => {
    const parsed = parseComicBarcode("001234567890");
    expect(parsed?.upc).toBe("001234567890");
    expect(parsed?.upc?.startsWith("00")).toBe(true);
  });
});
