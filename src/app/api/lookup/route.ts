import { lookupBarcode } from "@/lib/catalog/lookup";
import { logScanLookup } from "@/lib/log/events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const barcode = new URL(request.url).searchParams.get("barcode") ?? "";
  const result = await lookupBarcode(barcode);
  await logScanLookup({
    kind: "barcode",
    query: barcode,
    parsed: Boolean(result.parsed),
    owned: Boolean(result.owned),
    matches: result.matches.length,
    warnings: result.warnings,
  });
  return Response.json({
    parsed: result.parsed,
    owned: result.owned
      ? {
          id: result.owned.id,
          series: result.owned.series,
          issueNo: result.owned.issueNo,
          publisher: result.owned.publisher,
          grade: result.owned.grade,
          keyLevel: result.owned.keyLevel,
          rawOrSlabbed: result.owned.rawOrSlabbed,
          barcode: result.owned.barcode,
          coverUrl: result.owned.coverUrl,
          storageBox: result.owned.storageBox,
          variant: result.owned.variant,
        }
      : null,
    matches: result.matches,
    warnings: result.warnings,
    metron: result.metron,
  });
}
