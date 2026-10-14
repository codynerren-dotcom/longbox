export const AUTO_LINK_SCORE = 75;
export const DECADE_YEARS = 10;

export type EditionKind = "regular" | "facsimile" | "reprint" | "printing" | "anniversary" | "true-believers" | "omnibus";

export type EditionCopy = {
  series: string;
  issueNo?: string | null;
  title?: string | null;
  fullTitle?: string | null;
  variant?: string | null;
  variantDescription?: string | null;
  format?: string | null;
  subtitle?: string | null;
  publisher?: string | null;
  barcode?: string | null;
  coverYear?: number | null;
  releaseYear?: number | null;
  coverPrice?: unknown;
};

export type EditionProfile = {
  kind: EditionKind;
  reprint: boolean;
  baseSeries: string;
  searchNames: string[];
  reasons: string[];
};

export type MatchCandidate = {
  seriesName: string;
  issueNo: string;
  variant: string | null;
  coverYear: number | null;
  releaseYear: number | null;
  seriesYear: number | null;
  upc: string | null;
  publisher: string | null;
};

export type MatchScore = {
  score: number;
  auto: boolean;
  blocked: string | null;
  kind: EditionKind;
  candidateKind: EditionKind;
};

const KIND_LABEL: Record<EditionKind, string> = {
  regular: "regular",
  facsimile: "facsimile",
  reprint: "reprint",
  printing: "later printing",
  anniversary: "anniversary edition",
  "true-believers": "True Believers",
  omnibus: "omnibus",
};

export function priceAmount(value: unknown): number | null {
  if (value == null) return null;
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : typeof value === "object" ? String(value) : "";
  const match = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

export function detectEdition(copy: EditionCopy): EditionProfile {
  const text = [copy.series, copy.title, copy.fullTitle, copy.variant, copy.variantDescription, copy.format, copy.subtitle]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" \n ");
  const reasons: string[] = [];
  let kind = kindFromText(text);
  if (kind !== "regular") reasons.push(`The copy says ${KIND_LABEL[kind]}.`);
  const release = yearOf(copy.releaseYear);
  const cover = yearOf(copy.coverYear);
  if (release != null && cover != null && release - cover >= DECADE_YEARS) {
    reasons.push(`Release year ${release} is ${release - cover} years after cover year ${cover}.`);
    if (kind === "regular") kind = "facsimile";
  }
  const price = priceAmount(copy.coverPrice);
  if (price != null && price >= 3 && cover != null && cover <= 1985 && (release == null || release - cover >= DECADE_YEARS)) {
    reasons.push(`Cover price ${price.toFixed(2)} does not match a ${cover} comic.`);
    if (kind === "regular") kind = "facsimile";
  }
  const baseSeries = baseSeriesName(copy.series) || copy.series.trim();
  return {
    kind,
    reprint: kind !== "regular",
    baseSeries,
    searchNames: searchNames(kind, copy.series, baseSeries),
    reasons,
  };
}

export function scoreCandidate(copy: EditionCopy, candidate: MatchCandidate): MatchScore {
  const edition = detectEdition(copy);
  const candidateKind = kindFromText(`${candidate.seriesName} ${candidate.variant ?? ""}`);
  const copyBase = normName(edition.baseSeries);
  const candidateBase = normName(baseSeriesName(candidate.seriesName));
  let seriesPoints = 0;
  if (copyBase && candidateBase && copyBase === candidateBase) seriesPoints = 30;
  else if (copyBase && candidateBase && (copyBase.includes(candidateBase) || candidateBase.includes(copyBase))) seriesPoints = 16;
  if (edition.kind !== "regular" && candidateKind === edition.kind) seriesPoints = 30;
  if (edition.kind !== candidateKind) seriesPoints = Math.min(seriesPoints, 8);

  const wantedIssue = leadingIssue(copy.issueNo ?? "");
  const foundIssue = leadingIssue(candidate.issueNo);
  let issuePoints = 0;
  let blocked: string | null = null;
  if (wantedIssue && foundIssue) {
    if (sameIssueNumber(wantedIssue, foundIssue)) issuePoints = 25;
    else blocked = "Issue numbers do not match.";
  }

  const left = copyAnchor(copy, edition);
  const right = candidateAnchor(candidate, candidateKind);
  let yearPoints = left == null || right == null ? 8 : 0;
  if (left != null && right != null) {
    const gap = Math.abs(left - right);
    if (gap <= 1) yearPoints = 20;
    else if (gap === 2) yearPoints = 10;
    else {
      yearPoints = 0;
      blocked = blocked ?? `Release years are ${gap} years apart.`;
    }
  }
  if (edition.kind !== candidateKind) {
    blocked = blocked ?? `This copy is ${KIND_LABEL[edition.kind]} and the catalog issue is ${KIND_LABEL[candidateKind]}.`;
  }

  const variantPoints = variantOverlap(copy, candidate) ? 10 : 0;
  const upcPoints = upcPointsFor(copy.barcode ?? null, candidate.upc);
  const publisherPoints = publishersMatch(copy.publisher ?? null, candidate.publisher) ? 8 : 0;
  const score = Math.min(100, seriesPoints + issuePoints + yearPoints + variantPoints + upcPoints + publisherPoints);
  return {
    score,
    auto: blocked == null && score >= AUTO_LINK_SCORE && issuePoints === 25,
    blocked,
    kind: edition.kind,
    candidateKind,
  };
}

export function suspectMatchReason(copy: EditionCopy & { metronIssueId?: string | null; gcdIssueId?: string | null }): string | null {
  if (!copy.metronIssueId && !copy.gcdIssueId) return null;
  const edition = detectEdition(copy);
  const release = yearOf(copy.releaseYear);
  const cover = yearOf(copy.coverYear);
  const parts = [...edition.reasons];
  if (release != null && cover != null && Math.abs(release - cover) > 2 && !parts.some((part) => part.includes("Release year"))) {
    parts.push(`Release year ${release} and cover year ${cover} are ${Math.abs(release - cover)} years apart.`);
  }
  if (!edition.reprint && (release == null || cover == null || Math.abs(release - cover) <= 2)) return null;
  if (parts.length === 0) return null;
  return parts.join(" ");
}

function searchNames(kind: EditionKind, series: string, base: string): string[] {
  const names: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed && !names.some((name) => normName(name) === normName(trimmed))) names.push(trimmed);
  };
  if (kind === "facsimile" || kind === "reprint" || kind === "printing") add(`${base} Facsimile Edition`);
  if (kind === "true-believers") {
    add(`True Believers ${base}`);
    add(`${base} Facsimile Edition`);
  }
  if (kind === "omnibus") add(`${base} Omnibus`);
  if (kind === "anniversary") add(`${base} Anniversary`);
  if (kind === "reprint") add(`${base} Reprint`);
  add(series);
  if (kind !== "regular") add(base);
  return names;
}

export function kindFromText(value: string): EditionKind {
  const text = value.toLowerCase();
  if (/\btrue believers\b/.test(text)) return "true-believers";
  if (/\bfacsimiles?\b/.test(text)) return "facsimile";
  if (/\b(omnibus|compendium|absolute edition)\b/.test(text)) return "omnibus";
  if (/\banniversary\b/.test(text)) return "anniversary";
  if (/\breprints?\b/.test(text)) return "reprint";
  if (/(?:\b(?:second|third|fourth|fifth|sixth)\s+printing\b|\b(?:[2-9]|[1-9]\d)(?:st|nd|rd|th)\s+printing\b)/.test(text)) return "printing";
  return "regular";
}

export function baseSeriesName(series: string): string {
  return series
    .replace(/\s*\((?:18|19|20)\d{2}(?:\s+series)?\)\s*$/i, " ")
    .replace(/\bfacsimile edition\b/gi, " ")
    .replace(/\bfacsimiles?\b/gi, " ")
    .replace(/\btrue believers:?\b/gi, " ")
    .replace(/\banniversary edition\b/gi, " ")
    .replace(/\banniversary\b/gi, " ")
    .replace(/\breprint edition\b/gi, " ")
    .replace(/\breprints?\b/gi, " ")
    .replace(/\b(?:\d+)(?:st|nd|rd|th)\s+printing\b/gi, " ")
    .replace(/\b(?:second|third|fourth|fifth|sixth)\s+printing\b/gi, " ")
    .replace(/\bomnibus\b/gi, " ")
    .replace(/\bcompendium\b/gi, " ")
    .replace(/\babsolute edition\b/gi, " ")
    .replace(/[:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function copyAnchor(copy: EditionCopy, edition: EditionProfile): number | null {
  if (edition.reprint && yearOf(copy.releaseYear) != null) return yearOf(copy.releaseYear);
  return yearOf(copy.releaseYear) ?? yearOf(copy.coverYear);
}

function candidateAnchor(candidate: MatchCandidate, kind: EditionKind): number | null {
  const cover = yearOf(candidate.coverYear);
  const release = yearOf(candidate.releaseYear);
  const series = yearOf(candidate.seriesYear);
  if (kind !== "regular") {
    if (release != null) return release;
    if (series != null && cover != null && Math.abs(series - cover) >= DECADE_YEARS) return series;
    if (series != null && cover == null) return series;
  }
  return release ?? cover ?? series;
}

function variantOverlap(copy: EditionCopy, candidate: MatchCandidate): boolean {
  const want = normName([copy.variant, copy.variantDescription].filter(Boolean).join(" "));
  const got = normName(candidate.variant ?? "");
  if (!want || !got) return false;
  return want.includes(got) || got.includes(want);
}

function upcPointsFor(barcode: string | null, upc: string | null): number {
  const left = digitsOnly(barcode);
  const right = digitsOnly(upc);
  if (left.length < 11 || right.length < 11) return 0;
  if (left === right) return 15;
  if (left.startsWith(right) || right.startsWith(left)) return 8;
  return 0;
}

function publishersMatch(wanted: string | null, found: string | null): boolean {
  const a = normName(wanted ?? "");
  const b = normName(found ?? "");
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function yearOf(value: number | null | undefined): number | null {
  if (value == null || !Number.isInteger(value)) return null;
  if (value < 1800 || value > 2200) return null;
  return value;
}

function leadingIssue(value: string): string {
  const match = value.trim().match(/^#?\s*(\d+[A-Za-z]?)/);
  return match?.[1] ?? value.trim();
}

function sameIssueNumber(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (!/^\d+(?:\.0+)?$/.test(a) || !/^\d+(?:\.0+)?$/.test(b)) return false;
  return Number(a) === Number(b);
}

function digitsOnly(value: string | null): string {
  return (value ?? "").replace(/\D/g, "");
}

function normName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^\s*the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
