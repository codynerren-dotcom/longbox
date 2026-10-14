export type MatchCover = {
  label: string;
  imageUrl: string;
};

export type MatchHit = {
  source: "metron" | "comicvine";
  id: string;
  seriesId: string | null;
  series: string;
  issueNo: string;
  variant: string | null;
  coverDate: string | null;
  publisher: string | null;
  coverUrl: string | null;
  covers: MatchCover[];
};

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

export function mapMetronMatchHit(value: unknown): MatchHit | null {
  const row = record(value);
  const id = digits(row?.id);
  if (!row || !id) return null;
  const series = record(row.series);
  const seriesName = text(series?.name) ?? text(series?.series) ?? text(row.series);
  if (!seriesName) return null;
  const covers = variantCoversFrom(row);
  const variant = text(row.variant) ?? text(record(row.variant)?.name) ?? covers.find((cover) => cover.label !== "Cover")?.label ?? null;
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
