import { readFieldSources } from "@/lib/covers/enrich";
import type { MetronDetails } from "@/lib/covers/enrich";
import { readManualLink } from "@/lib/catalog/manual-link";
import type { MetronIssueHit } from "@/lib/covers/types";

export type CrossVia = "cv_id" | "gcd_id";

export type CrossCopy = {
  id: string;
  series: string;
  issueNo: string | null;
  issue: string | null;
  metronIssueId: string | null;
  manualMetronIssueId?: string | null;
  comicvineIssueId?: string | null;
  gcdIssueId?: string | null;
  /** Metron id named on a GCD record. Used before the Metron gcd_id filter. */
  embeddedMetronIssueId?: string | null;
  userCover?: boolean;
  coverFile?: string | null;
  coverStatus?: string | null;
};

export type CrossLookup = {
  byComicVine: (id: string) => Promise<MetronIssueHit[]>;
  byGcd: (id: string) => Promise<MetronIssueHit[]>;
};

export type CrossResult =
  | { status: "skip"; reason: string }
  | { status: "linked"; via: CrossVia; foreignId: string; hit: MetronIssueHit }
  | { status: "miss"; via: CrossVia; foreignId: string; reason: string }
  | { status: "many"; via: CrossVia; foreignId: string; ids: string[]; reason: string };

export function pickExactCrossHit(hits: MetronIssueHit[], key: "cvId" | "gcdId", id: string): { hit: MetronIssueHit } | { reason: string; ids: string[] } {
  const wanted = id.trim();
  const label = key === "cvId" ? "Comic Vine" : "GCD";
  const usable = hits.filter((hit) => {
    const got = hit[key];
    return got == null || got === "" || got === wanted;
  });
  const explicit = usable.filter((hit) => hit[key] === wanted);
  const pool = explicit.length > 0 ? explicit : usable;
  const unique = [...new Map(pool.map((hit) => [hit.id, hit])).values()];
  if (unique.length === 1) return { hit: unique[0] };
  if (unique.length === 0) return { reason: `Metron has no issue for ${label} ${wanted}.`, ids: [] };
  return { reason: `Several Metron issues share ${label} ${wanted} (${unique.map((hit) => hit.id).join(", ")}).`, ids: unique.map((hit) => hit.id) };
}

export function crossLinkDownloadsCover(copy: { userCover?: boolean; coverFile?: string | null; coverStatus?: string | null }): boolean {
  if (copy.userCover || copy.coverStatus === "manual") return false;
  if (copy.coverFile) return false;
  return true;
}

export async function lookupCrossIssue(copy: CrossCopy, lookup: CrossLookup): Promise<CrossResult> {
  if (copy.manualMetronIssueId?.trim()) {
    return { status: "skip", reason: `${labelOf(copy)} kept the hand-picked Metron ${copy.manualMetronIssueId.trim()}.` };
  }
  if (copy.metronIssueId?.trim()) {
    return { status: "skip", reason: `${labelOf(copy)} already has Metron ${copy.metronIssueId.trim()}.` };
  }
  const embedded = digits(copy.embeddedMetronIssueId);
  if (embedded) {
    return {
      status: "linked",
      via: "gcd_id",
      foreignId: digits(copy.gcdIssueId) ?? embedded,
      hit: { id: embedded, seriesId: null, seriesName: copy.series, number: copy.issueNo || copy.issue || "", coverYear: null, imageUrl: null, label: null },
    };
  }
  const cv = digits(copy.comicvineIssueId);
  if (cv) {
    const found = await decide("cv_id", cv, await lookup.byComicVine(cv), "cvId");
    if (found.status !== "miss") return found;
    const gcd = digits(copy.gcdIssueId);
    if (!gcd) return found;
    const next = await decide("gcd_id", gcd, await lookup.byGcd(gcd), "gcdId");
    if (next.status === "miss") return { ...found, reason: `${found.reason} ${next.reason}` };
    return next;
  }
  const gcd = digits(copy.gcdIssueId);
  if (gcd) return decide("gcd_id", gcd, await lookup.byGcd(gcd), "gcdId");
  return { status: "skip", reason: `${labelOf(copy)} has no Comic Vine or GCD id.` };
}

export function blankCrossIds(
  current: {
    comicvineIssueId?: unknown;
    comicvineSeriesId?: unknown;
    gcdIssueId?: unknown;
    gcdSeriesId?: unknown;
  },
  fieldSources: unknown,
  manualLink: unknown,
  detail: Pick<MetronDetails, "comicvineIssueId" | "comicvineSeriesId" | "gcdIssueId" | "gcdSeriesId">,
): { comicvineIssueId?: string; comicvineSeriesId?: string; gcdIssueId?: string; gcdSeriesId?: string } {
  const sources = readFieldSources(fieldSources);
  const manual = readManualLink(manualLink);
  const patch: { comicvineIssueId?: string; comicvineSeriesId?: string; gcdIssueId?: string; gcdSeriesId?: string } = {};
  if (detail.comicvineIssueId && !filled(textId(current.comicvineIssueId)) && sources.comicvineIssueId !== "user" && !manual.comicvineIssueId) {
    patch.comicvineIssueId = detail.comicvineIssueId;
  }
  if (detail.comicvineSeriesId && !filled(textId(current.comicvineSeriesId)) && sources.comicvineSeriesId !== "user") {
    patch.comicvineSeriesId = detail.comicvineSeriesId;
  }
  if (detail.gcdIssueId && !filled(textId(current.gcdIssueId)) && !manual.gcdIssueId) {
    patch.gcdIssueId = detail.gcdIssueId;
  }
  if (detail.gcdSeriesId && !filled(textId(current.gcdSeriesId))) patch.gcdSeriesId = detail.gcdSeriesId;
  return patch;
}

export function crossLinkLine(copy: CrossCopy, result: CrossResult): string | null {
  if (result.status === "skip") return null;
  const name = labelOf(copy);
  if (result.status === "linked") {
    const from = result.via === "cv_id" ? "Comic Vine" : "GCD";
    return `${name} linked Metron ${result.hit.id} from ${from} ${result.foreignId}.`;
  }
  return `${name}: ${result.reason}`;
}

function decide(via: CrossVia, foreignId: string, hits: MetronIssueHit[], key: "cvId" | "gcdId"): CrossResult {
  const picked = pickExactCrossHit(hits, key, foreignId);
  if ("hit" in picked) return { status: "linked", via, foreignId, hit: picked.hit };
  if (picked.ids.length > 1) return { status: "many", via, foreignId, ids: picked.ids, reason: picked.reason };
  return { status: "miss", via, foreignId, reason: picked.reason };
}

function labelOf(copy: CrossCopy): string {
  return `${copy.series} #${copy.issueNo || copy.issue || "?"}`;
}

function digits(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!/^\d{1,12}$/.test(text) || text === "0") return null;
  return text;
}

function textId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function filled(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}
