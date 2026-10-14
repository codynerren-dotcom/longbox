const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;

export type CatalogTarget = {
  metron: string | null;
  metronId: string | null;
  comicVine: string | null;
  comicVineId: string | null;
  gcd: string | null;
  gcdId: string | null;
  gcdCover: string | null;
};

export function metronSiteUrl(value: unknown, kind: "issue" | "series"): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "metron.cloud" && url.hostname !== "www.metron.cloud") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "api") return null;
  if (parts.length !== 2 || parts[0] !== kind) return null;
  if (!SLUG.test(parts[1])) return null;
  return `https://metron.cloud/${kind}/${parts[1]}/`;
}

export function metronIssueHref(id: string | null | undefined, siteUrl: string | null | undefined): string | null {
  return metronHref("issue", id, siteUrl);
}

export function metronSeriesHref(id: string | null | undefined, siteUrl: string | null | undefined): string | null {
  return metronHref("series", id, siteUrl);
}

export function comicVineIssueHref(id: string | null | undefined): string | null {
  const cv = digits(id);
  return cv ? `https://comicvine.gamespot.com/issue/4000-${cv}/` : null;
}

export function comicVineVolumeHref(id: string | null | undefined): string | null {
  const cv = digits(id);
  return cv ? `https://comicvine.gamespot.com/volume/4050-${cv}/` : null;
}

export function gcdIssueHref(id: string | null | undefined): string | null {
  const gcd = digits(id);
  return gcd ? `https://www.comics.org/issue/${gcd}/` : null;
}

export function gcdSeriesHref(id: string | null | undefined): string | null {
  const gcd = digits(id);
  return gcd ? `https://www.comics.org/series/${gcd}/` : null;
}

export function gcdCoverHref(id: string | null | undefined): string | null {
  const gcd = digits(id);
  return gcd ? `https://www.comics.org/issue/${gcd}/cover/4/` : null;
}

export function issueCatalogLinks(comic: {
  metronIssueId?: string | null;
  metronIssueUrl?: string | null;
  comicvineIssueId?: string | null;
  gcdIssueId?: string | null;
}): CatalogTarget {
  return {
    metron: metronIssueHref(comic.metronIssueId, comic.metronIssueUrl),
    metronId: digits(comic.metronIssueId),
    comicVine: comicVineIssueHref(comic.comicvineIssueId),
    comicVineId: digits(comic.comicvineIssueId),
    gcd: gcdIssueHref(comic.gcdIssueId),
    gcdId: digits(comic.gcdIssueId),
    gcdCover: gcdCoverHref(comic.gcdIssueId),
  };
}

export function seriesCatalogLinks(
  comics: Array<{
    metronSeriesId?: string | null;
    metronSeriesUrl?: string | null;
    comicvineSeriesId?: string | null;
    gcdSeriesId?: string | null;
  }>,
): CatalogTarget {
  const seriesId = mostCommon(comics.map((comic) => digits(comic.metronSeriesId)));
  const site = mostCommon(
    comics.filter((comic) => digits(comic.metronSeriesId) === seriesId).map((comic) => metronSiteUrl(comic.metronSeriesUrl, "series")),
  );
  const metron = site ?? (seriesId ? `https://metron.cloud/series/${seriesId}/` : mostCommon(comics.map((comic) => metronSiteUrl(comic.metronSeriesUrl, "series"))));
  const volumeId = mostCommon(comics.map((comic) => digits(comic.comicvineSeriesId)));
  const gcdId = mostCommon(comics.map((comic) => digits(comic.gcdSeriesId)));
  return {
    metron,
    metronId: seriesId,
    comicVine: comicVineVolumeHref(volumeId),
    comicVineId: volumeId,
    gcd: gcdSeriesHref(gcdId),
    gcdId,
    gcdCover: null,
  };
}

function metronHref(kind: "issue" | "series", id: string | null | undefined, siteUrl: string | null | undefined): string | null {
  const site = metronSiteUrl(siteUrl, kind);
  if (site) return site;
  const clean = digits(id);
  return clean ? `https://metron.cloud/${kind}/${clean}/` : null;
}

function digits(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,12}$/.test(trimmed) || trimmed === "0") return null;
  return trimmed;
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let count = 0;
  for (const [value, seen] of counts) {
    if (seen > count) {
      best = value;
      count = seen;
    }
  }
  return best;
}
