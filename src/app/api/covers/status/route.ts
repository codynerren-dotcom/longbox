import { readBackfillStatus } from "@/lib/covers/files";
import { readEditionJob } from "@/lib/covers/job-state";
import { normalizeBackfillStatus } from "@/lib/covers/poll";

export const dynamic = "force-dynamic";

export async function GET() {
  const backfill = normalizeBackfillStatus(readBackfillStatus());
  const rematch = readEditionJob();
  return Response.json(backfill ? { ...backfill, rematch } : { rematch }, { headers: { "Cache-Control": "no-store" } });
}
