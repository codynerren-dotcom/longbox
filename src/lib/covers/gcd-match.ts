import type { GcdCatalog, GcdIssueRow, GcdSeriesRow } from "@/lib/catalog/gcd";
import { createGcdCatalog } from "@/lib/catalog/gcd";
import type { MatchHit } from "@/lib/catalog/match-hits";
import { parseMatchQuery } from "@/lib/catalog/manual-link";
import { parseComicBarcode } from "@/lib/barcode";
import { calendarDay, daysApart, detectEdition, normName, scoreCandidate, seriesMentionsIssue, type MatchCandidate } from "@/lib/covers/edition";
import { chooseFacsimileIssue, choosePrintingIssue } from "@/lib/covers/match";
import type { MetronDetails } from "@/lib/covers/enrich";
import type { CoverDecision, CoverQuery, MetronIssueHit } from "@/lib/covers/types";
import {
  catalogNameQueries,
  gcdFormatMatches,
  isbnDigits,
  isCollected,
  normalizeSeriesName,
  resolveShelfFormat,
  sameIsbn,
  seriesNamesMatch,
  tradeSearchSeries,
  volumeNumber,
  type ShelfFormat,
} from "@/lib/shelf-format";

/**
 * Names to send to `/api/series/name/`. The base name goes first, after the issue
 * number, year, and Facsimile Edition are removed. Issue-number forms follow,
 * because GCD often stores that number inside the series title.
 */
export function gcdFacsimileQueries(series: string, issueNo: string | null): string[] {
  const names = gcdCoreNames(series);
  const issue = issueNo && /^\d+$/.test(issueNo) ? issueNo : null;
  const queries: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length < 3) return;
    if (/\bfacsimile\b/i.test(trimmed)) return;
    if (queries.some((query) => query.toLowerCase() === trimmed.toLowerCase())) return;
    queries.push(trimmed);
  };
  for (const name of names) {
    if (name.split(" ").filter(Boolean).length >= 2) add(name);
  }
  for (const name of names) {
    if (!issue) continue;
    add(`${name} ${issue}`);
    add(`${name} No. ${issue}`);
    add(`${name} #${issue}`);
  }
  return queries;
}

export async function searchGcdMatches(
  query: string,
  barcode: string,
  mode: "query" | "barcode",
  shelfFormat?: string | null,
  options?: { facsimile?: boolean; catalog?: GcdCatalog; shelfSeries?: string | null },
): Promise<MatchHit[]> {
  const catalog = options?.catalog ?? createGcdCatalog();
  const format = resolveShelfFormat({ shelfFormat });
  const typed = query.trim();
  const parsed = parseMatchQuery(mode === "barcode" && !typed ? "" : query);
  const shelf = tradeSearchSeries(options?.shelfSeries) || (options?.shelfSeries ?? "").trim();
  const series = parsed.series || (mode === "barcode" ? shelf : "") || typed;
  const probe: CoverQuery = {
    series,
    issueNo: parsed.issueNo,
    issue: parsed.issueNo,
    coverYear: null,
    barcode: barcode.trim() || null,
    variant: null,
    publisher: null,
    releaseYear: parsed.year,
    variantDescription: options?.facsimile || /\bfacsimile\b/i.test(query) ? "Facsimile Edition" : null,
  };
  if ((options?.facsimile || detectEdition(probe).kind === "facsimile") && probe.series.trim()) {
    const issues = await collectGcdFacsimileIssues(probe, catalog);
    return issues.map(gcdHit);
  }
  if (isCollected(format) || isbnDigits(barcode)) {
    const collected = await collectGcdCollectedIssues({ ...probe, shelfFormat: isCollected(format) ? format : "tp" }, isCollected(format) ? format : "tp", catalog);
    return collected.map(gcdHit);
  }
  if (!parsed.series) return [];
  let seriesRows: GcdSeriesRow[] = [];
  for (const name of uniqueNames([parsed.series], catalogNameQueries(parsed.series))) {
    const rows = await catalog.seriesByName(name);
    const named = rows.filter((row) => seriesNamesMatch(parsed.series, row.name));
    if (named.length > 0) {
      seriesRows = named;
      break;
    }
  }
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
  const shelf = resolveShelfFormat(comic);
  if (isCollected(shelf)) return resolveGcdCollected(comic, shelf, catalog);
  const edition = detectEdition(comic);
  if (edition.kind === "facsimile") return resolveGcdFacsimile(comic, edition, catalog);
  if (edition.kind === "printing") return resolveGcdPrinting(comic, edition, catalog);
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
  const names = uniqueNames(edition.searchNames.length > 0 ? edition.searchNames : [comic.series], catalogNameQueries(comic.series));
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
    comicvineIssueId: issue.comicvineIssueId,
    comicvineSeriesId: null,
    gcdIssueId: null,
    gcdSeriesId: null,
    collects: issue.collects,
  };
}

async function resolveGcdCollected(comic: CoverQuery, format: ShelfFormat, catalog: GcdCatalog): Promise<CoverDecision> {
  const seriesName = tradeSearchSeries(comic.series) || comic.series.trim();
  const issues = await collectGcdCollectedIssues(comic, format, catalog);
  if (issues.length === 0) {
    return { status: "unmatched", reason: `No GCD collected edition for ${seriesName || comic.series}.`, score: 0 };
  }
  const isbn = isbnDigits(comic.barcode);
  const best = issues[0];
  if (!best) return { status: "unmatched", reason: `No GCD collected edition for ${seriesName || comic.series}.`, score: 0 };
  if (isbn && sameIsbn(isbn, best.isbn, best.barcode)) {
    return { status: "matched", via: "gcd", issue: toHit(best), score: 98 };
  }
  if (issues.length === 1) return { status: "matched", via: "gcd", issue: toHit(best), score: 86 };
  return { status: "unmatched", reason: `Several GCD collected editions match ${seriesName || comic.series}.`, score: 70 };
}

/**
 * Names for `/api/series/name/`. GCD matches a literal prefix or a subtitle, not a bag of words.
 * `Beneath the Trees: Where Nobody Sees - Rite of Spring` returns nothing; the catalog name is
 * `Beneath the Trees Where Nobody Sees: Rite of Spring`. `Beneath the Trees` does return that series.
 */
export function gcdCollectedQueries(series: string | null | undefined): string[] {
  const raw = tradeSearchSeries(series).replace(/\s+/g, " ").trim();
  const queries: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length < 3) return;
    if (queries.some((query) => query.toLowerCase() === trimmed.toLowerCase())) return;
    queries.push(trimmed);
  };
  add(gcdNormalizedTitle(raw));
  add(raw);
  const colon = raw.indexOf(":");
  if (colon >= 0) {
    const after = raw.slice(colon + 1).trim();
    add(gcdNormalizedTitle(after));
    add(after);
  }
  const dash = raw.split(/\s+[-–—]\s+/);
  if (dash.length > 1) add(dash[dash.length - 1] ?? "");
  add(gcdBaseName(raw));
  return queries.slice(0, 6);
}

/** Collected series from the normalized name, then the issue whose ISBN matches. */
export async function collectGcdCollectedIssues(comic: CoverQuery, format: ShelfFormat, catalog: GcdCatalog): Promise<GcdIssueRow[]> {
  const seriesName = tradeSearchSeries(comic.series) || comic.series.trim();
  if (!seriesName) return [];
  const isbn = isbnDigits(comic.barcode);
  const volume = volumeNumber(comic.issueNo, comic.issue);
  const exact: GcdIssueRow[] = [];
  const fallback: GcdIssueRow[] = [];
  const seenSeries = new Set<string>();
  let fetched = 0;
  const trade = format === "tp" || format === "hc";
  const names = trade ? gcdCollectedQueries(seriesName) : catalogNameQueries(seriesName, { broad: true });
  const issueCap = trade ? 12 : 8;
  for (const name of names) {
    if (exact.length > 0 || fetched >= issueCap) break;
    const rows = await catalog.seriesByName(name);
    const kept = orderCollected(
      rows.filter((row) => keepCollectedSeries(row, seriesName, format)),
      format,
    );
    for (const series of kept) {
      if (exact.length > 0 || fetched >= issueCap) break;
      if (seenSeries.has(series.id)) continue;
      seenSeries.add(series.id);
      for (const item of series.issues.slice(0, 4)) {
        if (fetched >= issueCap) break;
        fetched += 1;
        const issue = await catalog.issue(item.id);
        if (!issue) continue;
        issue.seriesYear = issue.seriesYear ?? series.yearBegan;
        if (isbn && sameIsbn(isbn, issue.isbn, issue.barcode)) {
          exact.push(issue);
          continue;
        }
        const hasCode = Boolean((issue.isbn ?? "").replace(/\D/g, "") || (issue.barcode ?? "").replace(/\D/g, ""));
        if (isbn && hasCode) continue;
        if (collectedFallback(issue, comic, volume)) fallback.push(issue);
      }
    }
  }
  return exact.length > 0 ? exact : fallback;
}

function gcdNormalizedTitle(value: string): string {
  const parts = value
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const subtitle = parts[parts.length - 1] ?? "";
    const stem = parts
      .slice(0, -1)
      .join(" ")
      .replace(/:/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (stem && subtitle) return `${stem}: ${subtitle}`;
  }
  return value.replace(/\s+/g, " ").trim();
}

function gcdBaseName(value: string): string {
  const cut = value.split(/\s*(?::|[-–—])\s*/)[0] ?? "";
  return cut.replace(/\s+/g, " ").trim();
}

function collectedEdition(format: string | null | undefined): boolean {
  return /\bcollected edition\b/i.test(format ?? "");
}

/**
 * A two-token query such as "Beneath the Trees" cannot fuzzy-match a longer series name.
 * GCD already returned that series for the prefix, so a leading prefix or a trailing subtitle still counts.
 */
function nameRelated(wanted: string, found: string): boolean {
  if (seriesNamesMatch(wanted, found)) return true;
  const want = normalizeSeriesName(wanted);
  const got = normalizeSeriesName(found);
  if (!want || !got) return false;
  if (got === want || got.startsWith(`${want} `)) return true;
  return want.length >= 8 && got.endsWith(` ${want}`);
}

function keepCollectedSeries(row: GcdSeriesRow, seriesName: string, format: ShelfFormat): boolean {
  if ((format === "tp" || format === "hc") && collectedEdition(row.format)) return nameRelated(seriesName, row.name);
  if (format === "tp" || format === "hc") return gcdFormatMatches(row.format, row.name, format) && nameRelated(seriesName, row.name);
  return gcdFormatMatches(row.format, row.name, format) && seriesNamesMatch(seriesName, row.name);
}

function orderCollected(rows: GcdSeriesRow[], format: ShelfFormat): GcdSeriesRow[] {
  if (format !== "tp" && format !== "hc") return rows;
  return rows.slice().sort((a, b) => Number(collectedEdition(b.format)) - Number(collectedEdition(a.format)));
}

async function resolveGcdPrinting(comic: CoverQuery, edition: ReturnType<typeof detectEdition>, catalog: GcdCatalog): Promise<CoverDecision> {
  const barcode = comic.barcode ? parseComicBarcode(comic.barcode) : null;
  const collected: GcdIssueRow[] = [];
  if (barcode) {
    collected.push(...(await catalog.issuesByBarcode(barcode.combined)));
    if (barcode.upc && barcode.upc !== barcode.combined) collected.push(...(await catalog.issuesByBarcode(barcode.upc)));
    const decision = choosePrintingIssue(collected.map(toHit), comic, "gcd");
    if (decision.status === "matched") return decision;
  }
  const issueNo = edition.issueNo || "";
  let best: CoverDecision = { status: "unmatched", reason: `No later printing for ${comic.series} #${issueNo || "?"}.`, score: 0 };
  if (!comic.series.trim() || !issueNo) return best;
  let fetched = 0;
  for (const name of edition.searchNames) {
    const seriesRows = await catalog.seriesByName(name);
    const picked = pickSeries(seriesRows, name, comic.releaseYear ?? comic.coverYear);
    for (const series of picked) {
      const issueIds = issuesFor(series, issueNo, true).slice(0, 3);
      const batch: MetronIssueHit[] = [];
      for (const id of issueIds) {
        if (fetched >= 6) break;
        fetched += 1;
        const issue = await catalog.issue(id);
        if (!issue) continue;
        issue.seriesYear = issue.seriesYear ?? series.yearBegan;
        batch.push(toHit(issue));
      }
      if (batch.length === 0) continue;
      const decision = choosePrintingIssue(batch, comic, "gcd");
      if (decision.status === "matched") return decision;
      if (decision.score > best.score) best = decision;
      if (fetched >= 6) return best;
    }
  }
  return best;
}

async function resolveGcdFacsimile(comic: CoverQuery, edition: ReturnType<typeof detectEdition>, catalog: GcdCatalog): Promise<CoverDecision> {
  const issues = await collectGcdFacsimileIssues(comic, catalog);
  if (issues.length === 0) {
    return { status: "unmatched", reason: `No facsimile issue for ${comic.series} #${edition.issueNo || "?"}.`, score: 0 };
  }
  return chooseFacsimileIssue(issues.map(toHit), comic, "gcd");
}

/** Facsimile series from the core name, then the issues inside them, best barcode first. */
export async function collectGcdFacsimileIssues(comic: CoverQuery, catalog: GcdCatalog): Promise<GcdIssueRow[]> {
  const edition = detectEdition(comic);
  const issueNo = edition.issueNo || "";
  if (!comic.series.trim() || !issueNo) return [];
  const releaseYear = comic.releaseYear ?? yearFromDate(comic.releaseDate);
  let fallback: GcdIssueRow[] = [];
  let fetched = 0;
  for (const name of gcdFacsimileQueries(comic.series, issueNo).slice(0, 8)) {
    if (fetched >= 8) break;
    const rows = await catalog.seriesByName(name);
    const kept = keepFacsimileSeries(rows, issueNo, releaseYear);
    if (kept.length === 0) continue;
    const ranked = rankFacsimileIssues(await loadFacsimileIssues(kept, catalog), comic);
    fetched += ranked.length;
    if (ranked.length === 0) continue;
    const best = ranked[0]?.rank ?? 3;
    const picked = ranked.filter((row) => row.rank === best).map((row) => row.issue);
    if (best <= 1 || !comic.barcode) return picked;
    if (fallback.length === 0) fallback = picked;
  }
  return fallback;
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
    storeDate: issue.onSaleDate,
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
    storeDate: issue.storeDate ?? null,
  };
}

function gcdCoreNames(series: string): string[] {
  const withoutEdition = series
    .replace(/\bfacsimile editions?\b/gi, " ")
    .replace(/\bfacsimiles?\b/gi, " ")
    .replace(/#\s*\d+[A-Za-z]?/g, " ")
    .replace(/\b(?:18|19|20)\d{2}\b/g, " ");
  const base = withoutEdition
    .replace(/\s*\((?:18|19|20)\d{2}(?:\s+series)?\)\s*$/i, "")
    .replace(/,?\s+\bvol(?:ume)?\.?\s*\d+\s*$/i, "")
    .replace(/^\s*the\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const names: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/[^A-Za-z0-9!&'-]+/g, " ").replace(/\s+/g, " ").trim();
    if (trimmed.length < 3) return;
    if (names.some((name) => name.toLowerCase() === trimmed.toLowerCase())) return;
    names.push(trimmed);
  };
  const colon = base.indexOf(":");
  if (colon >= 0) add(base.slice(colon + 1));
  add(base);
  return names;
}

function keepFacsimileSeries(rows: GcdSeriesRow[], issueNo: string, releaseYear: number | null): GcdSeriesRow[] {
  const facsimile = rows.filter((row) => /facsimile/i.test(row.name) && seriesMentionsIssue(row.name, issueNo));
  const parenthetical = facsimile.filter((row) => /\(\s*facsimile edition\s*\)/i.test(row.name));
  const named = parenthetical.length > 0 ? parenthetical : facsimile;
  if (named.length === 0 || releaseYear == null) return named;
  const close = named.filter((row) => row.yearBegan == null || Math.abs(row.yearBegan - releaseYear) <= 1);
  if (close.length > 0) return close;
  return named.filter((row) => row.yearBegan == null || Math.abs(row.yearBegan - releaseYear) <= 3);
}

async function loadFacsimileIssues(seriesRows: GcdSeriesRow[], catalog: GcdCatalog): Promise<Array<{ issue: GcdIssueRow; descriptor: string }>> {
  const descriptors = new Map<string, { descriptor: string; year: number | null }>();
  for (const series of seriesRows.slice(0, 3)) {
    for (const issue of series.issues) {
      if (descriptors.size >= 6) break;
      if (!descriptors.has(issue.id)) descriptors.set(issue.id, { descriptor: issue.descriptor, year: series.yearBegan });
    }
  }
  const loaded: Array<{ issue: GcdIssueRow; descriptor: string }> = [];
  for (const [id, meta] of descriptors) {
    const issue = await catalog.issue(id);
    if (!issue) continue;
    issue.seriesYear = issue.seriesYear ?? meta.year;
    loaded.push({ issue: withDescriptor(issue, meta.descriptor), descriptor: meta.descriptor });
  }
  return loaded;
}

function rankFacsimileIssues(
  rows: Array<{ issue: GcdIssueRow; descriptor: string }>,
  comic: CoverQuery,
): Array<{ issue: GcdIssueRow; descriptor: string; rank: number }> {
  const hint = coverHint(comic.variantDescription);
  return rows
    .map((row, index) => {
      const agree = barcodeAgreement(comic.barcode, row.issue.barcode);
      const kind = coverHint(`${row.descriptor} ${row.issue.variant ?? ""}`);
      let rank = 3;
      if (agree === "exact") rank = 0;
      else if (agree === "prefix") rank = 1;
      else if (kind === hint) rank = 2;
      return { ...row, rank, index };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
}

function withDescriptor(issue: GcdIssueRow, descriptor: string): GcdIssueRow {
  if (issue.variant || !descriptor.trim()) return issue;
  const label = descriptor.replace(/^\[|\]$/g, "").trim();
  return label ? { ...issue, variant: label } : issue;
}

function coverHint(value: string | null | undefined): "foil" | "blank" | "regular" {
  const text = (value ?? "").toLowerCase();
  if (/\bfoil\b/.test(text)) return "foil";
  if (/\bblank\b/.test(text)) return "blank";
  return "regular";
}

function barcodeAgreement(copy: string | null | undefined, issue: string | null | undefined): "exact" | "prefix" | null {
  const want = (copy ?? "").replace(/\D/g, "");
  const got = (issue ?? "").replace(/\D/g, "");
  if (want.length < 12 || got.length < 12) return null;
  if (want === got) return "exact";
  if (want.startsWith(got) || got.startsWith(want)) return "prefix";
  return null;
}

function yearFromDate(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    return Number.isInteger(year) ? year : null;
  }
  const match = String(value).match(/\b((?:18|19|20)\d{2})\b/);
  return match?.[1] ? Number(match[1]) : null;
}

function uniqueNames(first: string[], second: string[]): string[] {
  const names: string[] = [];
  for (const name of [...first, ...second]) {
    const trimmed = name.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    if (names.some((item) => item.toLowerCase() === trimmed.toLowerCase())) continue;
    names.push(trimmed);
  }
  return names;
}

function collectedFallback(issue: GcdIssueRow, comic: CoverQuery, volume: string | null): boolean {
  if (!volume || !volumeMatches(issue, volume)) return false;
  if (comic.publisher && issue.publisher && !publisherAgrees(comic.publisher, issue.publisher)) return false;
  const copyDay = calendarDay(comic.releaseDate);
  const sale = calendarDay(issue.onSaleDate);
  if (copyDay && sale) {
    const days = daysApart(copyDay, sale);
    if (days == null || days > 60) return false;
  }
  return true;
}

function volumeMatches(issue: GcdIssueRow, volume: string): boolean {
  const number = issue.number.trim().toLowerCase();
  if (number === volume || number === `vol. ${volume}` || number === `vol ${volume}`) return true;
  if (number === "[nn]" || number === "" || number === "nn") return seriesMentionsIssue(issue.seriesName, volume);
  return false;
}

function publisherAgrees(wanted: string, found: string): boolean {
  const left = normName(wanted);
  const right = normName(found);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function pickSeries(rows: GcdSeriesRow[], name: string, year: number | null): GcdSeriesRow[] {
  const wanted = norm(name);
  const named = rows.filter((row) => {
    const got = norm(row.name);
    return seriesNamesMatch(name, row.name) || got === wanted || got.includes(wanted) || wanted.includes(got);
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
  if (ranked.length === 0 && reprint && seriesMentionsIssue(series.name, issueNo)) {
    return series.issues
      .filter((issue) => {
        const descriptor = issue.descriptor.trim().toLowerCase();
        return descriptor === "" || descriptor === "[nn]" || descriptor === "nn" || descriptor.startsWith("[");
      })
      .map((issue) => issue.id);
  }
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
