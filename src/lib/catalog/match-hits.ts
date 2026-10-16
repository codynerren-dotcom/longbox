import type { MetronIssueHit } from "@/lib/covers/types";

export type MatchCover = {
  label: string;
  imageUrl: string;
};

export type MatchHit = {
  source: "metron" | "comicvine" | "gcd";
  id: string;
  seriesId: string | null;
  series: string;
  issueNo: string;
  variant: string | null;
  coverDate: string | null;
  publisher: string | null;
  coverUrl: string | null;
  covers: MatchCover[];
  /** GCD issue barcode, when the issue payload sent one. */
  barcode?: string | null;
  /** GCD ISBN, when the issue has no barcode. */
  isbn?: string | null;
  /** GCD price string, such as `7.99 USD`. */
  price?: string | null;
  /** GCD on-sale day, `YYYY-MM-DD` when the payload sends one. */
  onSaleDate?: string | null;
  /** Cover page to open when the scan itself cannot be shown. */
  coverPageUrl?: string | null;
  /** Series start year, when the payload includes one. */
  seriesYear?: number | null;
  /** Series volume, when the payload includes one. */
  seriesVolume?: number | null;
};

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function whole(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function digits(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !/^\d{1,12}$/.test(raw) || raw === "0") return null;
  return raw;
}

export function httpsUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function publisherName(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  return text(record(value)?.name);
}

function dedupeCovers(covers: MatchCover[]): MatchCover[] {
  const seen = new Set<string>();
  const unique: MatchCover[] = [];
  for (const cover of covers) {
    if (seen.has(cover.imageUrl)) continue;
    seen.add(cover.imageUrl);
    unique.push(cover);
  }
  return unique;
}

export function variantCoversFrom(value: unknown): MatchCover[] {
  const row = record(value);
  if (!row) return [];
  const covers: MatchCover[] = [];
  const main = httpsUrl(row.image);
  if (main) covers.push({ label: "Cover", imageUrl: main });
  const lists = [row.variants, row.variant_covers, row.alt_covers, row.associated_images];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const entry = record(item);
      if (!entry) continue;
      const image = httpsUrl(entry.image) ?? httpsUrl(entry.cover) ?? httpsUrl(entry.original_url) ?? httpsUrl(entry.super_url) ?? httpsUrl(entry.medium_url);
      if (!image) continue;
      const label = text(entry.name) ?? text(entry.caption) ?? text(entry.sku) ?? "Variant";
      covers.push({ label, imageUrl: image });
    }
  }
  return dedupeCovers(covers);
}

export function matchHitFromIssue(hit: MetronIssueHit): MatchHit | null {
  if (!/^\d{1,12}$/.test(hit.id) || !hit.seriesName.trim()) return null;
  const covers = (hit.covers ?? []).filter((cover) => cover.imageUrl).map((cover) => ({ label: cover.label, imageUrl: cover.imageUrl }));
  if (hit.imageUrl && !covers.some((cover) => cover.imageUrl === hit.imageUrl)) covers.unshift({ label: "Cover", imageUrl: hit.imageUrl });
  return {
    source: "metron",
    id: hit.id,
    seriesId: hit.seriesId && /^\d{1,12}$/.test(hit.seriesId) ? hit.seriesId : null,
    series: hit.seriesName.trim(),
    issueNo: hit.number,
    variant: hit.variant ?? null,
    coverDate: hit.storeDate ?? (hit.coverYear != null ? String(hit.coverYear) : null),
    publisher: hit.publisher ?? null,
    coverUrl: hit.imageUrl,
    covers,
    barcode: hit.upc ?? null,
    ...(hit.seriesYear != null ? { seriesYear: hit.seriesYear } : {}),
    ...(hit.seriesVolume != null ? { seriesVolume: hit.seriesVolume } : {}),
  };
}

export function mapMetronMatchHit(value: unknown): MatchHit | null {
  const row = record(value);
  const id = digits(row?.id);
  if (!row || !id) return null;
  const series = record(row.series);
  const seriesName = text(series?.name) ?? text(series?.series) ?? text(row.series);
  if (!seriesName) return null;
  const covers = variantCoversFrom(row);
  const variant = text(row.variant) ?? text(record(row.variant)?.name) ?? covers.find((cover) => cover.label !== "Cover")?.label ?? null;
  const seriesYear = whole(series?.year_began);
  const seriesVolume = whole(series?.volume);
  return {
    source: "metron",
    id,
    seriesId: digits(series?.id),
    series: seriesName,
    issueNo: text(row.number) ?? "",
    variant,
    coverDate: text(row.cover_date),
    publisher: publisherName(series?.publisher) ?? publisherName(row.publisher),
    coverUrl: covers[0]?.imageUrl ?? null,
    covers,
    ...(seriesYear != null ? { seriesYear } : {}),
    ...(seriesVolume != null ? { seriesVolume } : {}),
  };
}

function comicVineImage(value: unknown): string | null {
  const row = record(value);
  if (!row) return httpsUrl(value);
  return httpsUrl(row.super_url) ?? httpsUrl(row.original_url) ?? httpsUrl(row.medium_url) ?? httpsUrl(row.small_url) ?? httpsUrl(row.thumb_url) ?? httpsUrl(row.image);
}

export function plainText(value: string | null): string | null {
  if (!value) return null;
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

export function mapComicVineMatchHit(value: unknown, publisher?: string | null): MatchHit | null {
  const row = record(value);
  const id = digits(row?.id);
  if (!row || !id) return null;
  const volume = record(row.volume);
  const series = text(volume?.name) ?? text(row.volume) ?? text(row.name);
  if (!series) return null;
  const image = comicVineImage(row.image);
  const covers = variantCoversFrom({ ...row, image });
  if (image && covers.length === 0) covers.push({ label: "Cover", imageUrl: image });
  return {
    source: "comicvine",
    id,
    seriesId: digits(volume?.id),
    series,
    issueNo: text(row.issue_number) ?? "",
    variant: text(row.name),
    coverDate: text(row.cover_date),
    publisher: publisherName(volume?.publisher) ?? publisherName(row.publisher) ?? text(publisher),
    coverUrl: covers[0]?.imageUrl ?? image,
    covers: dedupeCovers(covers),
  };
}

/** Put the requested cover year first. Other years stay in the list so a wrong year can still be picked. */
export function orderMatchHits(hits: MatchHit[], year: number | null): MatchHit[] {
  if (year == null) return hits;
  const token = String(year);
  return hits
    .map((hit, index) => ({ hit, index, rank: hit.coverDate?.includes(token) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.hit);
}
