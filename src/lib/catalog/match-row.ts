import { comicVineIssueHref, gcdIssueHref, metronIssueHref } from "@/lib/catalog-links";

/** Full digit strings, add-on included. A shorter code is not an exact match for a longer one. */
export function exactBarcodeMatch(copy: string | null | undefined, issue: string | null | undefined): boolean {
  const want = (copy ?? "").replace(/\D/g, "");
  const got = (issue ?? "").replace(/\D/g, "");
  return want.length >= 12 && want === got;
}

/** GCD's `w400` scan is the thumbnail. Drop the size folder so a tap opens the full file. */
export function fullSizeCoverUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname === "files1.comics.org") parsed.pathname = parsed.pathname.replace(/\/w\d+\//, "/");
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
