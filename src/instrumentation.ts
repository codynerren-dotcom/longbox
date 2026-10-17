export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { armEditionResumeSweep, scheduleFacsimileRematch } = await import("@/lib/covers/facsimile-rematch");
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    const { ensureRateHydrated } = await import("@/lib/catalog/rate-store");
    const { resumePausedCatalogJobs } = await import("@/lib/covers/run");
    await ensureRateHydrated();
    const { armSearchQueue } = await import("@/lib/catalog/search-queue-run");
    await armSearchQueue();
    await resumePausedCatalogJobs();
  }
  scheduleFacsimileRematch();
  armEditionResumeSweep();
}

type RequestError = Error & { digest?: string };

export async function onRequestError(
  error: RequestError,
  request: { path: string; method: string },
  context: { routePath?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportRequestError } = await import("@/lib/log/node-error");
    await reportRequestError(error, request, context);
  }
}
