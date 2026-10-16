import { comicVineIssueHref, gcdIssueHref, metronIssueHref } from "@/lib/catalog-links";

/** Full digit strings, add-on included. A shorter code is not an exact match for a longer one. */
export function exactBarcodeMatch(copy: string | null | undefined, issue: string | null | undefined): boolean {
  const want = (copy ?? "").replace(/\D/g, "");
  const got = (issue ?? "").replace(/\D/g, "");
  return want.length >= 12 && want === got;
}

/** files1.comics.org answers 403 to automated cover fetches and to hotlinks. */
export function isGcdScanHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "files1.comics.org";
  } catch {
    return false;
  }
}

/**
 * Shown under Use this cover when the selected row is GCD only.
 * The box stays available so a check can try Metron or Comic Vine.
 */
export const GCD_COVER_NOTE = "GCD doesn't allow cover downloads. Check this to try Metron or Comic Vine.";

/** Accept still saves the GCD link. The shelf cover is left as it is. */
export const GCD_COVER_MISSED =
  "GCD doesn't allow cover downloads; no other source had this cover. Use Upload cover or Take photo.";

/** A GCD row has no image we can show. Other catalogs start checked when a scan exists and the shelf cover is not a photo. */
export function defaultUseCover(source: "metron" | "comicvine" | "gcd", hasImage: boolean, userCover: boolean): boolean {
  if (userCover || source === "gcd") return false;
  return hasImage;
}

/** Full-size image for a catalog that serves the file. A files1 scan is not one of those. */
export function fullSizeCoverUrl(url: string | null | undefined): string | null {
  if (!url || isGcdScanHost(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function catalogIssueHref(source: "metron" | "comicvine" | "gcd", id: string): string | null {
  if (source === "gcd") return gcdIssueHref(id);
  if (source === "comicvine") return comicVineIssueHref(id);
  return metronIssueHref(id, null);
}

export function catalogViewLabel(source: "metron" | "comicvine" | "gcd"): string {
  if (source === "gcd") return "View on GCD";
  if (source === "comicvine") return "View on Comic Vine";
  return "View on Metron";
}
