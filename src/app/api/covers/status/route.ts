import { readBackfillStatus } from "@/lib/covers/files";
import { sweepEditionResume } from "@/lib/covers/facsimile-rematch";
import { readEditionJob } from "@/lib/covers/job-state";
import { normalizeBackfillStatus } from "@/lib/covers/poll";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    sweepEditionResume();
  } catch {
    // A failed sweep must not hide the status the page is polling.
  }
  const backfill = normalizeBackfillStatus(readBackfillStatus());
  const rematch = readEditionJob();
  return Response.json(backfill ? { ...backfill, rematch } : { rematch }, { headers: { "Cache-Control": "no-store" } });
}
