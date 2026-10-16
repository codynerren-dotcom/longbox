import { readFieldSources } from "@/lib/covers/enrich";
import type { MetronDetails } from "@/lib/covers/enrich";
import { readManualLink } from "@/lib/catalog/manual-link";
import { readCrossMiss, writeCrossMiss, type StoredCrossMiss } from "@/lib/covers/cross-miss";
import { sameIssueNumber } from "@/lib/covers/edition";
import type { MetronIssueHit } from "@/lib/covers/types";
import { catalogMatchIssue, catalogSeriesQuery, isCollected, metronSeriesType, volumeNumber } from "@/lib/shelf-format";

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
  barcode?: string | null;
  shelfFormat?: string | null;
  userCover?: boolean;
  coverFile?: string | null;
  coverStatus?: string | null;
};

/** Series name, issue number, series year, and barcode from a GCD or Comic Vine record. */
export type CrossForeign = {
  seriesName: string;
  number: string;
  seriesYear: number | null;
  barcode: string | null;
};

export type CrossNameQuery = {
  name: string;
  number: string;
  year: number | null;
  /** Set for a trade, hardcover, or omnibus so the name search does not land on the floppy. */
  seriesType?: string | null;
};

export type CrossLookup = {
  byComicVine: (id: string) => Promise<MetronIssueHit[]>;
  byGcd: (id: string) => Promise<MetronIssueHit[]>;
  /** GCD or Comic Vine fields for the one name query. */
  foreignIssue?: (via: CrossVia, id: string) => Promise<CrossForeign | null>;
  /** One Metron list request. No `alt_number` or `series_q` follow-up. */
  byName?: (query: CrossNameQuery) => Promise<MetronIssueHit[]>;
};

export type CrossResult =
  | { status: "skip"; reason: string }
  | { status: "linked"; via: CrossVia; foreignId: string; hit: MetronIssueHit }
  | { status: "miss"; via: CrossVia; foreignId: string; reason: string; nameSearched: boolean }
  | { status: "many"; via: CrossVia; foreignId: string; ids: string[]; reason: string }
  | { status: "candidates"; via: CrossVia; foreignId: string; hits: MetronIssueHit[]; reason: string; nameSearched: true };

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
  const gcd = digits(copy.gcdIssueId);
  if (!cv && !gcd) return { status: "skip", reason: `${labelOf(copy)} has no Comic Vine or GCD id.` };
  const cached = await readCrossMiss(cv, gcd);
  if (cached) return resultFromMiss(cached);
  if (cv) {
    const found = decide("cv_id", cv, await lookup.byComicVine(cv), "cvId");
    if (found.status !== "miss") return found;
  }
  if (gcd) {
    const found = decide("gcd_id", gcd, await lookup.byGcd(gcd), "gcdId");
    if (found.status !== "miss") return found;
  }
  const via: CrossVia = gcd ? "gcd_id" : "cv_id";
  const foreignId = gcd ?? cv ?? "";
  const result = await searchByName(copy, lookup, via, foreignId);
  if ((result.status === "miss" || result.status === "candidates") && result.nameSearched) {
    await writeCrossMiss(cv, gcd, {
      status: result.status,
      via: result.via,
      foreignId: result.foreignId,
      reason: result.reason,
      hits: result.status === "candidates" ? result.hits : [],
    });
  }
  return result;
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

/** Name, number, and series year sent on the one follow-up. The volume stays off the name. */
/** A collected shelf copy adds series_type and uses volume 1 when the foreign number is `TP` or blank. */
export function crossCollectedQuery(
  copy: { shelfFormat?: string | null; issueNo?: string | null; issue?: string | null },
  record: CrossForeign,
): CrossNameQuery {
  const base = crossNameQuery(record);
  const match = catalogMatchIssue(copy);
  if (!isCollected(match.format)) return base;
  return {
    ...base,
    number: volumeNumber(record.number) ?? match.number ?? base.number,
    seriesType: metronSeriesType(match.format),
  };
}

export function crossNameQuery(record: CrossForeign): CrossNameQuery {
  const parsed = catalogSeriesQuery(record.seriesName);
  return {
    name: parsed.name.trim(),
    number: record.number.trim(),
    year: record.seriesYear ?? parsed.yearBegan,
  };
}

export function crossForeignFromComicVine(value: unknown): (CrossForeign & { volumeId: string | null }) | null {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!row) return null;
  const volume = row.volume && typeof row.volume === "object" && !Array.isArray(row.volume) ? (row.volume as Record<string, unknown>) : null;
  const seriesName = textOf(volume?.name) ?? textOf(row.volume);
  const number = textOf(row.issue_number);
  if (!seriesName || !number) return null;
  const parsed = catalogSeriesQuery(seriesName);
  const start = wholeYear(volume?.start_year);
  return {
    seriesName,
    number,
    seriesYear: start ?? parsed.yearBegan,
    barcode: null,
    volumeId: digits(textOf(volume?.id)),
  };
}

/**
 * A barcode match links that issue. One hit whose stripped name, number, and series year
 * all match is linked. Every other list is left for the Match panel.
 */
export function classifyCrossNameHits(args: {
  via: CrossVia;
  foreignId: string;
  hits: MetronIssueHit[];
  record: CrossForeign;
  shelfBarcode?: string | null;
}): CrossResult {
  const unique = [...new Map(args.hits.map((hit) => [hit.id, hit])).values()];
  const codes = [args.record.barcode, args.shelfBarcode].filter((code): code is string => Boolean(code && code.trim()));
  const barcoded = unique.filter((hit) => hitMatchesBarcode(hit, codes));
  if (barcoded.length === 1) return { status: "linked", via: args.via, foreignId: args.foreignId, hit: barcoded[0] };
  const query = crossNameQuery(args.record);
  if (unique.length === 1 && exactNameHit(unique[0], query)) return { status: "linked", via: args.via, foreignId: args.foreignId, hit: unique[0] };
  if (unique.length === 0) return { status: "miss", via: args.via, foreignId: args.foreignId, reason: "not on Metron", nameSearched: true };
  const catalog = args.via === "gcd_id" ? "GCD" : "Comic Vine";
  return {
    status: "candidates",
    via: args.via,
    foreignId: args.foreignId,
    hits: unique,
    reason: `Metron has no ${catalog} cross-link; searched by name: ${unique.length} candidates`,
    nameSearched: true,
  };
}

function decide(via: CrossVia, foreignId: string, hits: MetronIssueHit[], key: "cvId" | "gcdId"): CrossResult {
  const picked = pickExactCrossHit(hits, key, foreignId);
  if ("hit" in picked) return { status: "linked", via, foreignId, hit: picked.hit };
  if (picked.ids.length > 1) return { status: "many", via, foreignId, ids: picked.ids, reason: picked.reason };
  return { status: "miss", via, foreignId, reason: picked.reason, nameSearched: false };
}

async function searchByName(copy: CrossCopy, lookup: CrossLookup, via: CrossVia, foreignId: string): Promise<CrossResult> {
  if (!lookup.byName || !lookup.foreignIssue) {
    return { status: "miss", via, foreignId, reason: "not on Metron", nameSearched: false };
  }
  let record: CrossForeign | null = null;
  try {
    record = await lookup.foreignIssue(via, foreignId);
  } catch (error) {
    if (isBudgetError(error)) throw error;
    record = null;
  }
  const query = record ? crossCollectedQuery(copy, record) : null;
  if (!record || !query?.name || !query.number) {
    return { status: "miss", via, foreignId, reason: "not on Metron", nameSearched: false };
  }
  const hits = await lookup.byName(query);
  return classifyCrossNameHits({ via, foreignId, hits, record, shelfBarcode: copy.barcode });
}

function resultFromMiss(row: StoredCrossMiss): CrossResult {
  if (row.status === "candidates" && row.hits.length > 0) {
    return { status: "candidates", via: row.via, foreignId: row.foreignId, hits: row.hits, reason: row.reason, nameSearched: true };
  }
  return { status: "miss", via: row.via, foreignId: row.foreignId, reason: row.reason, nameSearched: true };
}

function exactNameHit(hit: MetronIssueHit, query: CrossNameQuery): boolean {
  if (!query.name || !query.number || query.year == null || hit.seriesYear !== query.year) return false;
  const got = catalogSeriesQuery(hit.seriesName).name.trim().toLowerCase();
  if (got !== query.name.trim().toLowerCase()) return false;
  return sameIssueNumber(query.number, hit.number);
}

function hitMatchesBarcode(hit: MetronIssueHit, codes: string[]): boolean {
  if (codes.length === 0) return false;
  const found = [hit.upc, ...(hit.upcs ?? []), ...(hit.covers ?? []).map((cover) => cover.upc)];
  return codes.some((code) => found.some((upc) => sameBarcode(code, upc)));
}

function sameBarcode(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = barcodeDigits(left);
  const b = barcodeDigits(right);
  if (a.length < 12 || b.length < 12) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return long.startsWith(short) && long.length - short.length === 5;
}

function barcodeDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function textOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function wholeYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1800 && value <= 2100) return value;
  if (typeof value === "string" && /^(?:18|19|20)\d{2}$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function isBudgetError(error: unknown): boolean {
  return error instanceof Error && (error.name === "GcdBudgetError" || error.name === "MetronBudgetError" || error.name === "ComicVineBudgetError");
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
