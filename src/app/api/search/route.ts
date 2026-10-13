import { searchCatalog } from "@/lib/catalog/lookup";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const issue = url.searchParams.get("issue") ?? "";
  const result = await searchCatalog(q, issue);
  return Response.json(result);
}
