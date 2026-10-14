import { readBackfillStatus } from "@/lib/covers/files";
import { normalizeBackfillStatus } from "@/lib/covers/poll";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(normalizeBackfillStatus(readBackfillStatus()), { headers: { "Cache-Control": "no-store" } });
}
