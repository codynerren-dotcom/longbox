export type CatalogIdKind = "metron-issue" | "metron-series" | "comicvine-issue" | "comicvine-series" | "gcd-issue" | "gcd-series";

export type CatalogMention = { kind: "text"; text: string } | { kind: "id"; catalog: CatalogIdKind; id: string };

const RULES: Array<{ pattern: RegExp; catalog: CatalogIdKind }> = [
  { pattern: /\bMetron series\s+(\d{1,12})\b/gi, catalog: "metron-series" },
  { pattern: /\bMetron issue\s+(\d{1,12})\b/gi, catalog: "metron-issue" },
  { pattern: /\bMetron\s+(\d{1,12})\b/gi, catalog: "metron-issue" },
  { pattern: /\bComic\s*Vine series\s+(\d{1,12})\b/gi, catalog: "comicvine-series" },
  { pattern: /\bComic\s*Vine\s+(\d{1,12})\b/gi, catalog: "comicvine-issue" },
  { pattern: /\bGCD series\s+(\d{1,12})\b/gi, catalog: "gcd-series" },
  { pattern: /\bGCD\s+(\d{1,12})\b/gi, catalog: "gcd-issue" },
];

const PAREN_IDS = /\((\d{1,12}(?:\s*,\s*\d{1,12})+)\)/g;

/** Split a log line so each named catalog id can be rendered as its own link. */
export function catalogMentions(message: string): CatalogMention[] {
  type Hit = { start: number; end: number; catalog: CatalogIdKind; id: string };
  const hits: Hit[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of message.matchAll(re)) {
      const id = match[1];
      if (!id || id === "0" || match.index == null) continue;
      const start = match.index + match[0].lastIndexOf(id);
      hits.push({ start, end: start + id.length, catalog: rule.catalog, id });
    }
  }
  for (const match of message.matchAll(PAREN_IDS)) {
    const body = match[1];
    if (!body || match.index == null) continue;
    const before = message.slice(Math.max(0, match.index - 80), match.index);
    if (!/\bMetron\b/.test(before) || !/\bissues?\b/i.test(before)) continue;
    const bodyStart = match.index + 1;
    for (const idMatch of body.matchAll(/\d{1,12}/g)) {
      const id = idMatch[0];
      if (!id || id === "0" || idMatch.index == null) continue;
      const start = bodyStart + idMatch.index;
      hits.push({ start, end: start + id.length, catalog: "metron-issue", id });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    kept.push(hit);
    cursor = hit.end;
  }
  const parts: CatalogMention[] = [];
  let at = 0;
  for (const hit of kept) {
    if (hit.start > at) parts.push({ kind: "text", text: message.slice(at, hit.start) });
    parts.push({ kind: "id", catalog: hit.catalog, id: hit.id });
    at = hit.end;
  }
  if (at < message.length) parts.push({ kind: "text", text: message.slice(at) });
  if (parts.length === 0) parts.push({ kind: "text", text: message });
  return parts;
}

export function detailIdKind(key: string, via: unknown): CatalogIdKind | null {
  if (key === "foreignId") {
    if (via === "cv_id") return "comicvine-issue";
    if (via === "gcd_id") return "gcd-issue";
    return null;
  }
  switch (key) {
    case "metronIssueId":
      return "metron-issue";
    case "metronSeriesId":
      return "metron-series";
    case "comicvineIssueId":
      return "comicvine-issue";
    case "comicvineSeriesId":
      return "comicvine-series";
    case "gcdIssueId":
      return "gcd-issue";
    case "gcdSeriesId":
      return "gcd-series";
    default:
      return null;
  }
}

export function catalogIdText(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 1_000_000_000_000) return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{1,12}$/.test(text) || text === "0") return null;
  return text;
}
