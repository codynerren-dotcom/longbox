import type { MatchHit } from "@/lib/catalog/match-hits";
import { exactBarcodeMatch, isGcdScanHost } from "@/lib/catalog/match-row";
import { matchQuery } from "@/lib/catalog/manual-link";
import { seriesNamesMatch, seriesTitleFits } from "@/lib/shelf-format";

export type CoverWanted = {
  series: string;
  issueNo: string;
  variant: string | null;
  barcode: string | null;
  year: number | null;
};

export type AlternateCover = {
  source: "metron" | "comicvine";
  issueId: string;
  imageUrl: string;
  primaryUrl: string | null;
};

type CoverSearch = ((query: string) => Promise<MatchHit[]>) | null;

export type AlternateCoverSearch = {
  metronBarcode: CoverSearch;
  metronQuery: CoverSearch;
  comicVineBarcode: CoverSearch;
  comicVineQuery: CoverSearch;
};

type TaggedHit = MatchHit & { via: "barcode" | "name" };

/**
 * Metron or Comic Vine cover for the same issue. Barcode first, then series name and number.
 * An image whose label matches the GCD variant outranks the publisher's regular cover.
 * A files1 URL is never a candidate.
 */
export async function findAlternateCover(wanted: CoverWanted, search: AlternateCoverSearch): Promise<AlternateCover | null> {
  const barcodeHits = await barcodeCandidates(wanted, search);
  const fromBarcode = pickAlternateCover(wanted, barcodeHits);
  if (fromBarcode && (!wanted.variant?.trim() || variantAgrees(wanted.variant, fromBarcode.variantLabel))) return fromBarcode;
  const nameHits = await nameCandidates(wanted, search);
  return pickAlternateCover(wanted, [...barcodeHits, ...nameHits]);
}

export function pickAlternateCover(wanted: CoverWanted, hits: TaggedHit[]): (AlternateCover & { variantLabel: string | null }) | null {
  let best: { cover: AlternateCover & { variantLabel: string | null }; score: number; index: number } | null = null;
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (!hit || hit.source === "gcd") continue;
    if (hit.via === "name" && !sameIssue(wanted, hit)) continue;
    const images = hit.covers.length > 0 ? hit.covers : hit.coverUrl ? [{ label: hit.variant ?? "Cover", imageUrl: hit.coverUrl }] : [];
    for (const image of images) {
      if (!image.imageUrl || isGcdScanHost(image.imageUrl)) continue;
      const labelMatch = variantAgrees(wanted.variant, image.label);
      const hitMatch = variantAgrees(wanted.variant, hit.variant);
      let score = hit.via === "barcode" ? 40 : 0;
      if (exactBarcodeMatch(wanted.barcode, hit.barcode)) score += 100;
      if (labelMatch) score += 50;
      else if (hitMatch) score += 40;
      if (sameNumber(wanted.issueNo, hit.issueNo)) score += 15;
      if (seriesAgrees(wanted.series, hit.series)) score += 15;
      if (hit.via === "name" && score < 30) continue;
      if (hit.via === "barcode" && score < 40) continue;
      const cover: AlternateCover & { variantLabel: string | null } = {
        source: hit.source,
        issueId: hit.id,
        imageUrl: image.imageUrl,
        primaryUrl: hit.coverUrl && !isGcdScanHost(hit.coverUrl) ? hit.coverUrl : image.imageUrl,
        variantLabel: labelMatch ? image.label : null,
      };
      const current = best;
      const better =
        !current ||
        score > current.score ||
        (score === current.score && sourceRank(hit.source) < sourceRank(current.cover.source)) ||
        (score === current.score && hit.source === current.cover.source && index < current.index);
      if (better) best = { cover, score, index };
    }
  }
  return best ? best.cover : null;
}

async function barcodeCandidates(wanted: CoverWanted, search: AlternateCoverSearch): Promise<TaggedHit[]> {
  const code = (wanted.barcode ?? "").trim();
  if (code.replace(/\D/g, "").length < 12) return [];
  const hits: TaggedHit[] = [];
  await push(search.metronBarcode, code, "barcode", hits);
  await push(search.comicVineBarcode, code, "barcode", hits);
  return hits;
}

async function nameCandidates(wanted: CoverWanted, search: AlternateCoverSearch): Promise<TaggedHit[]> {
  const query = matchQuery({ series: wanted.series, issueNo: wanted.issueNo, year: wanted.year });
  if (!wanted.series.trim() || !query.trim()) return [];
  const hits: TaggedHit[] = [];
  await push(search.metronQuery, query, "name", hits);
  await push(search.comicVineQuery, query, "name", hits);
  return hits;
}

async function push(search: CoverSearch, query: string, via: "barcode" | "name", hits: TaggedHit[]): Promise<void> {
  if (!search) return;
  const rows = await search(query);
  for (const hit of rows) hits.push({ ...hit, via });
}

function sourceRank(source: "metron" | "comicvine"): number {
  return source === "metron" ? 0 : 1;
}

function seriesAgrees(wanted: string, found: string): boolean {
  return seriesNamesMatch(wanted, found) || seriesTitleFits(wanted, found);
}

function sameNumber(wanted: string, found: string): boolean {
  const left = wanted.trim().replace(/^#/, "");
  const right = found.trim().replace(/^#/, "");
  if (!left || !right) return false;
  if (left.toLowerCase() === right.toLowerCase()) return true;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(left) === Number(right);
  return false;
}

function sameIssue(wanted: CoverWanted, hit: MatchHit): boolean {
  return sameNumber(wanted.issueNo, hit.issueNo) && seriesAgrees(wanted.series, hit.series);
}

function variantAgrees(wanted: string | null | undefined, found: string | null | undefined): boolean {
  const left = variantKey(wanted);
  const right = variantKey(found);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  if (shorter.length < 3) return false;
  return left.includes(right) || right.includes(left);
}

function variantKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:cover|variant|edition)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
