import "server-only";

import { blocksFromWindows, limitNotices, type LimitSource } from "@/lib/catalog/limit-notice";

/** Notice for sources that are already paused, used when a manual button is clicked. */
export async function pausedLimitNotice(sources: LimitSource[]): Promise<string | null> {
  const { ensureRateHydrated, readComicVineWindow, readGcdWindow, readMetronWindow } = await import("@/lib/catalog/rate-store");
  const { readMetronCircuit } = await import("@/lib/covers/metron-circuit");
  await ensureRateHydrated();
  const now = Date.now();
  const metron = readMetronWindow();
  const gcd = readGcdWindow();
  const vine = readComicVineWindow();
  const circuit = readMetronCircuit();
  const wanted = new Set(sources);
  const blocks = blocksFromWindows({
    now,
    metronPausedUntil: metron.pausedUntil,
    metronBudget: "Metron",
    metron,
    circuitOpenUntil: circuit.openUntil,
    gcdPausedUntil: gcd.pausedUntil,
    gcdBudget: gcd.mode === "authenticated" ? "GCD daily" : "GCD hourly",
    comicVinePausedUntil: vine.pausedUntil,
  }).filter((block) => wanted.has(block.source));
  if (blocks.length === 0) return null;
  return limitNotices(blocks, []);
}
