import { searchCatalog } from "@/lib/catalog/lookup";
import { logScanLookup } from "@/lib/log/events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const issue = url.searchParams.get("issue") ?? "";
  const result = await searchCatalog(q, issue);
  await logScanLookup({
    kind: "search",
    query: issue ? `${q} #${issue}` : q,
    matches: result.matches.length,
    warnings: result.warnings,
  });
  return Response.json(result);
}
