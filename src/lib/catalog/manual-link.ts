export type CatalogSource = "metron" | "comicvine" | "gcd";

export type ManualLink = {
  metronIssueId: string | null;
  comicvineIssueId: string | null;
  gcdIssueId: string | null;
  coverImageUrl: string | null;
  coverSource: "metron" | "comicvine" | null;
  /** True when the cover on the shelf is a photo the user uploaded. Backfill must leave it alone. */
  userCover: boolean;
  /** Original photo, kept beside the resized cover for a later recognition pass. Not served publicly. */
  originalFile: string | null;
};

const EMPTY: ManualLink = {
  metronIssueId: null,
  comicvineIssueId: null,
  gcdIssueId: null,
  coverImageUrl: null,
  coverSource: null,
  userCover: false,
  originalFile: null,
};

const ORIGINAL_FILE = /^user-[a-z0-9]{20,32}-original\.(?:jpg|png|webp|heic|heif)$/;

function digits(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{1,12}$/.test(text) || text === "0") return null;
  return text;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function readManualLink(value: unknown): ManualLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY };
  const row = value as Record<string, unknown>;
  const coverSource = row.coverSource === "metron" || row.coverSource === "comicvine" ? row.coverSource : null;
  const coverImageUrl = httpsUrl(row.coverImageUrl);
  const originalFile = typeof row.originalFile === "string" && ORIGINAL_FILE.test(row.originalFile) ? row.originalFile : null;
  return {
    metronIssueId: digits(row.metronIssueId),
    comicvineIssueId: digits(row.comicvineIssueId),
    gcdIssueId: digits(row.gcdIssueId),
    coverImageUrl: coverSource ? coverImageUrl : null,
    coverSource: coverSource && coverImageUrl ? coverSource : null,
    userCover: row.userCover === true,
    originalFile,
  };
}

export function manualLinkJson(link: unknown): ManualLink | null {
  const next = readManualLink(link);
  if (!next.metronIssueId && !next.comicvineIssueId && !next.gcdIssueId && !next.coverImageUrl && !next.userCover && !next.originalFile) return null;
  return next;
}

/** Remember this catalog id and, when a cover was chosen, which image to keep. */
export function withLinkedId(current: unknown, source: CatalogSource, issueId: string, coverImageUrl: string | null): ManualLink {
  const link = readManualLink(current);
  const id = digits(issueId);
  if (!id) return link;
  if (source === "metron") link.metronIssueId = id;
  else if (source === "comicvine") link.comicvineIssueId = id;
  else link.gcdIssueId = id;
  const image = httpsUrl(coverImageUrl);
  if (image && source !== "gcd") {
    link.coverImageUrl = image;
    link.coverSource = source;
    link.userCover = false;
  }
  return link;
}

/** Remember that the cover file was uploaded, and where the untouched photo lives. */
export function withUserCover(current: unknown, originalFile: string): ManualLink {
  const link = readManualLink(current);
  link.userCover = true;
  if (ORIGINAL_FILE.test(originalFile)) link.originalFile = originalFile;
  return link;
}

/** A catalog cover was chosen on purpose. The original photo stays on disk. */
export function withoutUserCover(current: unknown): ManualLink {
  const link = readManualLink(current);
  link.userCover = false;
  return link;
}

/** Drop a cover write while a user photo is still the cover of record. */
export function stripLockedCover(
  data: { coverFile?: unknown; coverUrl?: unknown; coverStatus?: unknown; coverNote?: unknown; manualLink?: unknown },
  currentLink: unknown,
): void {
  const next = data.manualLink !== undefined ? readManualLink(data.manualLink) : readManualLink(currentLink);
  if (!next.userCover) return;
  delete data.coverFile;
  delete data.coverUrl;
  delete data.coverStatus;
  delete data.coverNote;
}

/** Drop one catalog id. A cover chosen from that catalog is dropped with it. */
export function withoutLinkedId(current: unknown, source: CatalogSource): ManualLink {
  const link = readManualLink(current);
  if (source === "metron") link.metronIssueId = null;
  else if (source === "comicvine") link.comicvineIssueId = null;
  else link.gcdIssueId = null;
  if (link.coverSource === source) {
    link.coverImageUrl = null;
    link.coverSource = null;
  }
  return link;
}

export function matchQuery(comic: { series: string; issueNo: string | null | undefined; year: number | null | undefined }): string {
  const parts = [comic.series.trim()];
  const issue = comic.issueNo?.trim().replace(/^#/, "");
  if (issue) parts.push(`#${issue}`);
  if (comic.year != null && Number.isInteger(comic.year)) parts.push(String(comic.year));
  return parts.filter(Boolean).join(" ");
}

export function parseMatchQuery(query: string): { series: string; issueNo: string | null; year: number | null } {
  let text = query.replace(/\s+/g, " ").trim();
  let year: number | null = null;
  const yearMatch = text.match(/\b((?:18|19|20)\d{2})\b/);
  if (yearMatch?.[1]) {
    year = Number.parseInt(yearMatch[1], 10);
    text = text.replace(yearMatch[0], " ").replace(/\s+/g, " ").trim();
  }
  let issueNo: string | null = null;
  const hashed = text.match(/#\s*([0-9]+[A-Za-z]?)/);
  const bare = hashed ? null : text.match(/(?:^|\s)([0-9]+[A-Za-z]?)(?:\s|$)/);
  const found = hashed?.[1] ?? bare?.[1] ?? null;
  if (found) {
    issueNo = found;
    text = text.replace(hashed?.[0] ?? bare?.[0] ?? found, " ").replace(/\s+/g, " ").trim();
  }
  return { series: text, issueNo, year };
}
