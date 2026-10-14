import type { GcdCatalog, GcdIssueRow, GcdSeriesRow } from "@/lib/catalog/gcd";
import { createGcdCatalog } from "@/lib/catalog/gcd";
import type { MatchHit } from "@/lib/catalog/match-hits";
import { parseMatchQuery } from "@/lib/catalog/manual-link";
import { parseComicBarcode } from "@/lib/barcode";
import { detectEdition, scoreCandidate, type MatchCandidate } from "@/lib/covers/edition";
import type { MetronDetails } from "@/lib/covers/enrich";
import type { CoverDecision, CoverQuery, MetronIssueHit } from "@/lib/covers/types";

export async function searchGcdMatches(query: string, barcode: string, mode: "query" | "barcode"): Promise<MatchHit[]> {
  const catalog = createGcdCatalog();
  if (mode === "barcode") {
    const code = barcode.trim();
    if (!code) return [];
    const issues = await catalog.issuesByBarcode(code);
    return issues.map(gcdHit);
  }
  const parsed = parseMatchQuery(query);
  if (!parsed.series) return [];
  const seriesRows = await catalog.seriesByName(parsed.series);
  const hits: MatchHit[] = [];
  for (const series of seriesRows.slice(0, 3)) {
    const ids = (parsed.issueNo ? issuesFor(series, parsed.issueNo, true) : series.issues.map((issue) => issue.id)).slice(0, 4);
    for (const id of ids) {
      const issue = await catalog.issue(id);
      if (!issue) continue;
      issue.seriesYear = issue.seriesYear ?? series.yearBegan;
      hits.push(gcdHit(issue));
      if (hits.length >= 12) return hits;
    }
  }
  return hits;
}

export function gcdHit(issue: GcdIssueRow): MatchHit {
  return {
    source: "gcd",
    id: issue.id,
    seriesId: issue.seriesId,
    series: issue.seriesName,
    issueNo: issue.number,
    variant: issue.variant,
    coverDate: issue.coverDate,
    publisher: issue.publisher,
    coverUrl: null,
    covers: [],
  };
}

export async function resolveGcdCover(comic: CoverQuery, catalog: GcdCatalog): Promise<CoverDecision> {
  const edition = detectEdition(comic);
  const issueNo = (comic.issueNo || comic.issue || "").trim();
  const barcode = comic.barcode ? parseComicBarcode(comic.barcode) : null;
  if (barcode) {
    const hits = await catalog.issuesByBarcode(barcode.combined);
    const decision = chooseGcd(hits, comic, issueNo);
    if (decision.status === "matched") return decision;
  }
  if (!comic.series.trim() || !issueNo) {
    return { status: "unmatched", reason: "GCD needs a series and issue number.", score: 0 };
  }
  const names = edition.searchNames.length > 0 ? edition.searchNames : [comic.series];
  let best: CoverDecision = { status: "unmatched", reason: `No GCD series named ${comic.series}.`, score: 0 };
  let fetched = 0;
  for (const name of names) {
    const seriesRows = await catalog.seriesByName(name);
    const picked = pickSeries(seriesRows, name, edition.reprint ? (comic.releaseYear ?? comic.coverYear) : comic.coverYear);
    for (const series of picked) {
      const issueIds = issuesFor(series, issueNo, edition.reprint).slice(0, 2);
      for (const id of issueIds) {
        if (fetched >= 4) return best;
        fetched += 1;
        const issue = await catalog.issue(id);
        if (!issue) continue;
        issue.seriesYear = issue.seriesYear ?? series.yearBegan;
        const decision = chooseGcd([issue], comic, issueNo);
        if (decision.status === "matched") return decision;
        if (decision.score > best.score) best = decision;
      }
    }
  }
  return best;
}

export function gcdDetails(issue: GcdIssueRow): MetronDetails {
  const release = issue.onSaleDate && /^\d{4}-\d{2}-\d{2}/.test(issue.onSaleDate) ? new Date(`${issue.onSaleDate.slice(0, 10)}T12:00:00.000Z`) : null;
  return {
    id: issue.id,
    seriesId: issue.seriesId,
    seriesName: issue.seriesName,
    number: issue.number,
    imageUrl: null,
    coverDate: issue.coverDate,
    coverYear: issue.coverYear,
    releaseDate: release && !Number.isNaN(release.getTime()) ? release : null,
    title: issue.title,
    storyArc: null,
    plot: null,
    pageCount: issue.pageCount,
    coverPrice: money(issue.price),
    barcode: issue.barcode,
    writer: issue.writer,
    artist: issue.artist,
    coverArtist: issue.coverArtist,
    characters: issue.characters,
    teams: null,
    imprint: issue.publisher,
    seriesYear: issue.seriesYear,
    seriesVolume: null,
    metronIssueUrl: null,
    metronSeriesUrl: null,
    comicvineIssueId: null,
    comicvineSeriesId: null,
  };
}

function chooseGcd(issues: GcdIssueRow[], comic: CoverQuery, issueNo: string): CoverDecision {
  const hits = issues.map(toHit);
  if (hits.length === 0) return { status: "unmatched", reason: "No GCD issue for that search.", score: 0 };
  const ranked = hits
    .map((issue) => ({ issue, scored: scoreCandidate({ ...comic, issueNo: issueNo || comic.issueNo }, candidateFrom(issue)) }))
    .sort((a, b) => b.scored.score - a.scored.score);
  const best = ranked[0];
  const next = ranked[1];
  if (best && best.scored.auto && (!next || !next.scored.auto || best.scored.score >= next.scored.score + 12)) {
    return { status: "matched", via: "gcd", issue: best.issue, score: best.scored.score };
  }
  const why = best?.scored.blocked ?? `score ${best?.scored.score ?? 0} is below the match line`;
  return { status: "unmatched", reason: `GCD: ${why}.`, score: best?.scored.score ?? 0 };
}

function toHit(issue: GcdIssueRow): MetronIssueHit {
  return {
    id: issue.id,
    seriesId: issue.seriesId,
    seriesName: issue.seriesName,
    number: issue.number,
    coverYear: issue.coverYear,
    imageUrl: null,
    label: issue.variant,
    releaseYear: issue.onSaleYear,
    seriesYear: issue.seriesYear,
    upc: issue.barcode,
    publisher: issue.publisher,
    variant: issue.variant,
  };
}

function candidateFrom(issue: MetronIssueHit): MatchCandidate {
  return {
    seriesName: issue.seriesName,
    issueNo: issue.number,
    variant: issue.variant ?? issue.label,
    coverYear: issue.coverYear,
    releaseYear: issue.releaseYear ?? null,
    seriesYear: issue.seriesYear ?? null,
    upc: issue.upc ?? null,
    publisher: issue.publisher ?? null,
  };
}

function pickSeries(rows: GcdSeriesRow[], name: string, year: number | null): GcdSeriesRow[] {
  const wanted = norm(name);
  const named = rows.filter((row) => {
    const got = norm(row.name);
    return got === wanted || got.includes(wanted) || wanted.includes(got);
  });
  const pool = named.length > 0 ? named : [];
  if (year == null) return pool.slice(0, 2);
  const dated = pool.filter((row) => (row.yearBegan == null || row.yearBegan <= year) && (row.yearEnded == null || row.yearEnded >= year));
  const chosen = (dated.length > 0 ? dated : pool).slice().sort((a, b) => (b.yearBegan ?? 0) - (a.yearBegan ?? 0));
  return chosen.slice(0, 2);
}

function issuesFor(series: GcdSeriesRow, issueNo: string, reprint: boolean): string[] {
  const wanted = issueNo.trim().toLowerCase();
  const ranked = series.issues
    .map((issue) => ({ id: issue.id, descriptor: issue.descriptor.toLowerCase(), reprint: /facsimile|reprint|printing|omnibus|true believers|anniversary/.test(issue.descriptor.toLowerCase()) }))
    .filter((issue) => issue.descriptor === wanted || issue.descriptor.startsWith(`${wanted} `) || issue.descriptor.startsWith(`${wanted}[`));
  ranked.sort((a, b) => {
    const preferA = reprint ? a.reprint : !a.reprint;
    const preferB = reprint ? b.reprint : !b.reprint;
    return Number(preferB) - Number(preferA);
  });
  return ranked.map((issue) => issue.id);
}

function money(value: string | null): string | null {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount === 0) return null;
  return amount.toFixed(2);
}

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^\s*the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
