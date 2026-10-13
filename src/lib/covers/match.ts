import { parseComicBarcode } from "@/lib/barcode";
import type { CoverDecision, CoverLookup, CoverQuery, MetronIssueHit, MetronSeriesHit } from "@/lib/covers/types";

export function coverYearOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\b(18|19|20)\d{2}\b/);
  if (!match) return null;
  const year = Number.parseInt(match[0], 10);
  return Number.isFinite(year) ? year : null;
}

export function sameIssueNumber(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (!/^\d+(?:\.0+)?$/.test(a) || !/^\d+(?:\.0+)?$/.test(b)) return false;
  return Number(a) === Number(b);
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

function publishersMatch(wanted: string | null, found: string | null): boolean {
  if (!wanted || !found) return false;
  const a = normName(wanted);
  const b = normName(found);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function seriesCoversYear(series: MetronSeriesHit, year: number): boolean {
  if (series.yearBegan != null && series.yearBegan > year) return false;
  if (series.yearEnd != null && series.yearEnd < year) return false;
  return true;
}

export function narrowSeries(hits: MetronSeriesHit[], comic: CoverQuery): MetronSeriesHit[] {
  const wanted = normName(comic.series);
  if (!wanted) return [];
  let rows = hits.filter((hit) => normName(hit.name) === wanted);
  if (rows.length === 0) return [];
  if (comic.publisher) {
    const published = rows.filter((hit) => publishersMatch(comic.publisher, hit.publisher));
    if (published.length > 0) rows = published;
  }
  if (comic.coverYear != null) {
    const inYear = rows.filter((hit) => seriesCoversYear(hit, comic.coverYear as number));
    if (inYear.length > 0) {
      const best = Math.max(...inYear.map((hit) => hit.yearBegan ?? Number.NEGATIVE_INFINITY));
      const closest = inYear.filter((hit) => (hit.yearBegan ?? Number.NEGATIVE_INFINITY) === best);
      if (closest.length > 0) rows = closest;
    }
  }
  return rows;
}

function withImage(hits: MetronIssueHit[]): MetronIssueHit[] {
  const imaged = hits.filter((hit) => hit.imageUrl);
  return imaged.length > 0 ? imaged : hits;
}

function filterVariant(hits: MetronIssueHit[], variant: string | null): MetronIssueHit[] {
  const needle = variant ? normName(variant) : "";
  if (!needle) return hits;
  const matched = hits.filter((hit) => normName(hit.label ?? "").includes(needle));
  return matched.length > 0 ? matched : hits;
}

function issueToken(comic: CoverQuery): string {
  return (comic.issueNo || comic.issue || "").trim();
}

function labelFor(comic: CoverQuery, issueNo: string): string {
  const year = comic.coverYear != null ? ` (${comic.coverYear})` : "";
  return `${comic.series} #${issueNo || "?"}${year}`;
}

export function chooseIssue(
  hits: MetronIssueHit[],
  comic: CoverQuery,
  issueNo: string,
  via: "barcode" | "series",
): CoverDecision {
  const name = labelFor(comic, issueNo);
  if (hits.length === 0) {
    return { status: "unmatched", reason: `No Metron issue for ${name}.` };
  }

  const trustSingleBarcode = via === "barcode" && hits.length === 1;
  let rows = hits;
  if (issueNo) {
    const numbered = rows.filter((hit) => sameIssueNumber(hit.number, issueNo));
    if (numbered.length > 0) rows = numbered;
    else if (via === "series") return { status: "unmatched", reason: `No Metron issue for ${name}.` };
  }

  if (comic.coverYear != null && !trustSingleBarcode) {
    const dated = rows.filter((hit) => hit.coverYear === comic.coverYear);
    if (dated.length === 0) {
      return { status: "unmatched", reason: `Metron has ${comic.series} #${issueNo || "?"}, but not cover year ${comic.coverYear}.` };
    }
    rows = dated;
  }

  rows = filterVariant(rows, comic.variant);
  rows = withImage(rows);

  if (rows.length === 1) {
    const issue = rows[0];
    if (!issue.imageUrl) {
      return { status: "unmatched", reason: `Metron issue ${issue.id} has no cover image.` };
    }
    return { status: "matched", via, issue };
  }

  const ids = rows.map((hit) => hit.id).join(", ");
  if (via === "barcode") {
    return { status: "unmatched", reason: `Several Metron issues share this barcode (${ids}).` };
  }
  return { status: "unmatched", reason: `Several Metron covers for ${name} (${ids}).` };
}

export async function resolveCover(comic: CoverQuery, lookup: CoverLookup): Promise<CoverDecision> {
  const issueNo = issueToken(comic);
  const barcode = comic.barcode ? parseComicBarcode(comic.barcode) : null;

  if (barcode) {
    let hits = await lookup.issuesByUpc(barcode.combined);
    if (hits.length === 0 && barcode.upc && barcode.upc !== barcode.combined) {
      hits = await lookup.issuesByUpcPrefix(barcode.upc);
    }
    if (hits.length > 0) {
      const decision = chooseIssue(hits, comic, issueNo, "barcode");
      if (decision.status === "matched" || hits.length > 1) return decision;
      if (decision.status === "unmatched" && !decision.reason.startsWith("No Metron issue")) return decision;
    }
  }

  if (!comic.series.trim() || !issueNo) {
    return { status: "unmatched", reason: "No barcode and no series plus issue number to search." };
  }

  const found = await lookup.searchSeries(comic.series);
  const candidates = narrowSeries(found, comic);
  if (candidates.length === 0) {
    return { status: "unmatched", reason: `No Metron series named ${comic.series}.` };
  }
  if (candidates.length > 4) {
    return { status: "unmatched", reason: `Several Metron series named ${comic.series}.` };
  }

  if (candidates.length > 1) {
    const matched: MetronIssueHit[] = [];
    for (const candidate of candidates) {
      const issues = await lookup.issuesForSeries(candidate.id, issueNo, comic.coverYear);
      const decision = chooseIssue(issues, comic, issueNo, "series");
      if (decision.status === "matched") matched.push(decision.issue);
    }
    if (matched.length === 1) return { status: "matched", via: "series", issue: matched[0] };
    if (matched.length === 0) return { status: "unmatched", reason: `No Metron issue for ${labelFor(comic, issueNo)}.` };
    return { status: "unmatched", reason: `Several Metron series named ${comic.series} have #${issueNo}.` };
  }

  const issues = await lookup.issuesForSeries(candidates[0].id, issueNo, comic.coverYear);
  return chooseIssue(issues, comic, issueNo, "series");
}
