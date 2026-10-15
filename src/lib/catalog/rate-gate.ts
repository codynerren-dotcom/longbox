import {
  COVER_MIN_GAP_MS,
  EBAY_MIN_GAP_MS,
  notePacePause,
  pauseLabel,
  planPaceAcquire,
  type PaceWindow,
} from "@/lib/catalog/rate-limit";

/**
 * Persisted gaps for outbound calls that are not a Metron, GCD, or Comic Vine
 * API resource. Cover files have no published limit in Metron's RATELIMIT.md.
 * eBay documents per-app caps through Analytics getRateLimits; the token probe
 * uses a local gap until that call exists. Retry-After is stored on the window.
 */

async function reservePace(name: string, now: number, minGapMs: number, source: string): Promise<void> {
  const { ensureRateHydrated, readPaceWindow, savePaceWindow } = await import("@/lib/catalog/rate-store");
  await ensureRateHydrated();
  const plan = planPaceAcquire(readPaceWindow(name), now, minGapMs);
  if (plan.kind === "pause") {
    await savePaceWindow(name, plan.state);
    throw new Error(pauseLabel(source, plan.hold.resumeAt));
  }
  await savePaceWindow(name, plan.state);
  if (plan.waitMs > 0 && process.env.VITEST !== "true") {
    await new Promise((resolve) => setTimeout(resolve, plan.waitMs));
  }
}

async function rememberPace(name: string, resumeAt: number): Promise<void> {
  const { readPaceWindow, savePaceWindow } = await import("@/lib/catalog/rate-store");
  const next: PaceWindow = notePacePause(readPaceWindow(name), resumeAt);
  await savePaceWindow(name, next);
}

/** One cover-file download. At most one per second, remembered across restarts. */
export async function reserveCoverDownload(now = Date.now()): Promise<void> {
  await reservePace("covers", now, COVER_MIN_GAP_MS, "Cover download");
}

export async function noteCoverPause(resumeAt: number): Promise<void> {
  await rememberPace("covers", resumeAt);
}

/** One eBay token request. Two seconds apart, remembered across restarts. */
export async function reserveEbayRequest(now = Date.now()): Promise<void> {
  await reservePace("ebay", now, EBAY_MIN_GAP_MS, "eBay");
}

export async function noteEbayPause(resumeAt: number): Promise<void> {
  await rememberPace("ebay", resumeAt);
}
