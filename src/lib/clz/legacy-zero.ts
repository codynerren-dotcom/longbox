import type { NormalizedComic } from "@/lib/clz/parse";

const ZERO_CORE = /^0+(\.0+)?$/;
const LEGACY_KEY = /^core:0+(\.0+)?\|var:[^|]*\|idx:[^|]*$/;

export type LegacyZeroRow = {
  id: string;
  dedupeKey: string;
  series: string;
  issueNo: string | null;
  variant: string | null;
  coverFile: string | null;
  coverUrl: string | null;
  coverStatus: string | null;
  metronIssueId: string | null;
  coverNote: string | null;
};

export type LegacyCover = {
  coverFile: string;
  coverUrl: string | null;
  coverStatus: string | null;
  metronIssueId: string | null;
  coverNote: string | null;
};

export type LegacyZeroPlan = {
  retarget: Array<{ id: string; fromKey: string; dedupeKey: string }>;
  remove: Array<{ id: string; coverOntoKey: string | null; cover: LegacyCover | null }>;
};

/** The v1 key for a Core ComicID of 0. Those rows collapsed or duplicated once 0 stopped counting as an id. */
export function isLegacyZeroCoreKey(dedupeKey: string): boolean {
  return LEGACY_KEY.test(dedupeKey);
}

export function legacyZeroCoreKeys(comic: NormalizedComic): string[] {
  const raw = comic.rawRow["Core ComicID"].trim();
  if (!ZERO_CORE.test(raw)) return [];
  const variant = (comic.variant ?? "").trim().toLowerCase();
  const index = comic.clzIndex ?? "";
  const suffix = `|var:${variant}|idx:${index}`;
  return [...new Set([`core:${raw}${suffix}`, `core:0${suffix}`, `core:0.0${suffix}`])];
}

export function planZeroIdCleanup(incoming: NormalizedComic[], stale: LegacyZeroRow[], occupiedKeys: Set<string>): LegacyZeroPlan {
  const retarget: LegacyZeroPlan["retarget"] = [];
  const remove: LegacyZeroPlan["remove"] = [];
  const taken = new Set(occupiedKeys);

  for (const row of stale) {
    if (!isLegacyZeroCoreKey(row.dedupeKey)) continue;
    const matches = incoming.filter((comic) => legacyZeroCoreKeys(comic).includes(row.dedupeKey));
    if (matches.length === 0) continue;
    const cover = row.coverFile
      ? {
          coverFile: row.coverFile,
          coverUrl: row.coverUrl,
          coverStatus: row.coverStatus,
          metronIssueId: row.metronIssueId,
          coverNote: row.coverNote,
        }
      : null;
    if (matches.length > 1) {
      remove.push({ id: row.id, coverOntoKey: coverTarget(matches, row), cover });
      continue;
    }
    const target = matches[0].dedupeKey;
    if (target === row.dedupeKey) continue;
    if (taken.has(target)) {
      remove.push({ id: row.id, coverOntoKey: target, cover });
      continue;
    }
    retarget.push({ id: row.id, fromKey: row.dedupeKey, dedupeKey: target });
    taken.add(target);
    taken.delete(row.dedupeKey);
  }

  return { retarget, remove };
}

function coverTarget(matches: NormalizedComic[], row: LegacyZeroRow): string {
  const series = row.series.trim().toLowerCase();
  const issueNo = row.issueNo ?? "";
  const variant = (row.variant ?? "").trim().toLowerCase();
  const hit = matches.find(
    (comic) =>
      comic.series.trim().toLowerCase() === series &&
      (comic.issueNo ?? "") === issueNo &&
      (comic.variant ?? "").trim().toLowerCase() === variant,
  );
  return (hit ?? matches[0]).dedupeKey;
}
