export type RematchOutcome = "matched" | "unmatched" | "skipped" | "stopped" | "deferred" | "metron-budget";

/**
 * Walk linked copies once. A Metron budget does not stop the pass: the current copy is retried
 * on GCD when that lookup has not run yet, and later copies stay on GCD. A GCD budget skips GCD
 * for a short window and leaves Metron running. Deferred copies are left for the resume timer,
 * so the pass is not marked done.
 */
export async function runFacsimilePass(deps: {
  already: () => Promise<boolean>;
  markDone: () => Promise<void>;
  ids: () => Promise<Array<{ id: string; manual: boolean }>>;
  rematch: (id: string, ctx?: { metron: boolean }) => Promise<RematchOutcome>;
}): Promise<{ matched: number; unmatched: number; skipped: number; deferred: number; done: boolean }> {
  if (await deps.already()) return { matched: 0, unmatched: 0, skipped: 0, deferred: 0, done: true };
  const rows = await deps.ids();
  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  let deferred = 0;
  let metron = true;
  for (const row of rows) {
    if (row.manual) {
      skipped += 1;
      continue;
    }
    let outcome = await deps.rematch(row.id, { metron });
    if (outcome === "metron-budget") {
      metron = false;
      outcome = await deps.rematch(row.id, { metron: false });
    }
    if (outcome === "stopped") return { matched, unmatched, skipped, deferred, done: false };
    if (outcome === "deferred" || outcome === "metron-budget") {
      metron = false;
      deferred += 1;
      continue;
    }
    if (outcome === "matched") matched += 1;
    else if (outcome === "skipped") skipped += 1;
    else unmatched += 1;
  }
  if (deferred > 0) return { matched, unmatched, skipped, deferred, done: false };
  await deps.markDone();
  return { matched, unmatched, skipped, deferred, done: true };
}

/** Matched wins. A skipped Metron lookup stays deferred until GCD has been tried, then waits for Metron. */
export function editionOutcome(input: { matched: boolean; metronSkipped: boolean; gcdTried: boolean }): RematchOutcome {
  if (input.matched) return "matched";
  if (input.metronSkipped && !input.gcdTried) return "metron-budget";
  if (input.metronSkipped) return "deferred";
  return "unmatched";
}
