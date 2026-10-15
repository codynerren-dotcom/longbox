export type RematchOutcome = "matched" | "unmatched" | "skipped" | "stopped";

export async function runFacsimilePass(deps: {
  already: () => Promise<boolean>;
  markDone: () => Promise<void>;
  ids: () => Promise<Array<{ id: string; manual: boolean }>>;
  rematch: (id: string) => Promise<RematchOutcome>;
}): Promise<{ matched: number; unmatched: number; skipped: number; done: boolean }> {
  if (await deps.already()) return { matched: 0, unmatched: 0, skipped: 0, done: true };
  const rows = await deps.ids();
  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.manual) {
      skipped += 1;
      continue;
    }
    const outcome = await deps.rematch(row.id);
    if (outcome === "stopped") return { matched, unmatched, skipped, done: false };
    if (outcome === "matched") matched += 1;
    else if (outcome === "skipped") skipped += 1;
    else unmatched += 1;
  }
  await deps.markDone();
  return { matched, unmatched, skipped, done: true };
}
