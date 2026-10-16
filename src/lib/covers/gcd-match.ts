import type { GcdCatalog, GcdIssueRow, GcdSeriesRow } from "@/lib/catalog/gcd";
import { createGcdCatalog, gcdCoverHref } from "@/lib/catalog/gcd";
import { GcdNameMiss, gcdBareFranchise, gcdSeriesNameKey, gcdSeriesNameQueries, rankGcdSeries, shelfIsUsBook } from "@/lib/catalog/gcd-name";
import { parseGcdIssueRef } from "@/lib/catalog/gcd-ref";
import { exactBarcodeMatch } from "@/lib/catalog/match-row";
import type { MatchHit } from "@/lib/catalog/match-hits";
import { parseMatchQuery } from "@/lib/catalog/manual-link";
import { parseComicBarcode } from "@/lib/barcode";
import { calendarDay, daysApart, detectEdition, normName, sameIssueNumber, scoreCandidate, seriesMentionsIssue, type MatchCandidate } from "@/lib/covers/edition";
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
  seriesSoloTitle,
  tradeSearchSeries,
  volumeNumber,
  type ShelfFormat,
} from "@/lib/shelf-format";

/** One issue plus its variants. Keeps a search or a direct load inside the hourly cap. */
const VARIANT_FETCH_CAP = 8;
/** Match panel lists every cover of one issue. Still bounded so one search cannot spend the hour. */
const MATCH_VARIANT_CAP = 24;

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
  options?: {
    facsimile?: boolean;
    catalog?: GcdCatalog;
    shelfSeries?: string | null;
    publisher?: string | null;
    country?: string | null;
    language?: string | null;
    /** Shelf cover year. A barcode query often has no year of its own. */
    year?: number | null;
  },
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
    const issues = await collectGcdFacsimileIssues(probe, catalog, { every: true });
    return orderGcdMatchHits(issues.map((issue) => gcdHit(issue)), barcode);
  }
  if (isCollected(format) || isbnDigits(barcode)) {
    const collected = await collectGcdCollectedIssues({ ...probe, shelfFormat: isCollected(format) ? format : "tp" }, isCollected(format) ? format : "tp", catalog);
    return orderGcdMatchHits(collected.map(gcdHit), barcode);
  }
  const wanted = parsed.series || series;
  if (!wanted.trim()) return [];
  const year = parsed.year ?? options?.year ?? null;
  const hint = {
    name: wanted,
    publisher: options?.publisher,
    year,
    usBook: shelfIsUsBook({ country: options?.country, language: options?.language, barcode }),
  };
  const fullBarcode = barcode.replace(/\D/g, "").length >= 12;
  const names = wanted.includes("/") ? gcdSlashMatchNames(wanted) : slashSafeNames(uniqueNames([wanted], catalogNameQueries(wanted)));
  let seriesRows: GcdSeriesRow[] = [];
  let misses = 0;
  if (wanted.includes("/")) {
    const required = new Set(gcdSeriesNameQueries(wanted).map((name) => name.toLowerCase()));
    const asked = new Set<string>();
    const pool: GcdSeriesRow[] = [];
    const seen = new Set<string>();
    let fallback: GcdSeriesRow[] = [];
    for (const name of names) {
      asked.add(name.toLowerCase());
      let rows: GcdSeriesRow[] = [];
      try {
        rows = await catalog.seriesByName(name);
      } catch (error) {
        if (error instanceof GcdNameMiss) {
          misses += 1;
          continue;
        }
        throw error;
      }
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        pool.push(row);
      }
      if (fallback.length === 0) {
        const named = rows.filter((row) => seriesNamesMatch(name, row.name) || seriesNamesMatch(wanted, row.name));
        const solos =
          named.length > 0
            ? []
            : rows.filter((row) => knownIssueCount(row) === 1 && (seriesSoloTitle(name, row.name) || seriesSoloTitle(wanted, row.name)));
        const picked = named.length > 0 ? named : solos;
        if (picked.length > 0) fallback = picked;
      }
      const requiredDone = [...required].every((query) => asked.has(query));
      if (!requiredDone) continue;
      const named = pool.filter((row) => gcdSeriesNameKey(row.name) === gcdSeriesNameKey(wanted));
      if (named.length > 0 || fallback.length > 0) break;
    }
    const named = pool.filter((row) => gcdSeriesNameKey(row.name) === gcdSeriesNameKey(wanted));
    const ranked = rankGcdSeries(await resolvePublishers(named, catalog), hint);
    seriesRows = ranked.length > 0 ? ranked : fallback;
  } else {
    for (const name of names) {
      let rows: GcdSeriesRow[] = [];
      try {
        rows = await catalog.seriesByName(name);
      } catch (error) {
        if (error instanceof GcdNameMiss) {
          misses += 1;
          continue;
        }
        throw error;
      }
      const named = rows.filter((row) => seriesNamesMatch(name, row.name) || seriesNamesMatch(wanted, row.name));
      const solos =
        named.length > 0
          ? []
          : rows.filter((row) => knownIssueCount(row) === 1 && (seriesSoloTitle(name, row.name) || seriesSoloTitle(wanted, row.name)));
      const picked = named.length > 0 ? named : solos;
      if (picked.length > 0) {
        const ranked = rankGcdSeries(picked, hint);
        seriesRows = ranked.length > 0 ? ranked : picked;
        break;
      }
    }
  }
  if (seriesRows.length === 0 && names.length > 0 && misses === names.length) throw new GcdNameMiss(wanted);
  const hits: MatchHit[] = [];
  for (const seriesRow of seriesRows.slice(0, 3)) {
    const familyIds = new Set(gcdMatchIssueIds(seriesRow, parsed.issueNo, year));
    const ids = mode === "barcode" && fullBarcode ? gcdBarcodeIssueIds(seriesRow, familyIds) : [...familyIds];
    const family: MatchHit[] = [];
    for (const id of ids) {
      const issue = await catalog.issue(id);
      if (!issue) continue;
      issue.seriesYear = issue.seriesYear ?? seriesRow.yearBegan;
      const descriptor = seriesRow.issues.find((item) => item.id === id)?.descriptor ?? "";
      const hit = gcdHit(withDescriptor(issue, descriptor));
      if (mode === "barcode" && fullBarcode && !familyIds.has(id) && !exactBarcodeMatch(barcode, hit.barcode)) continue;
      family.push(hit);
    }
    hits.push(...orderGcdMatchHits(family, barcode));
    if (mode === "barcode" && fullBarcode && hits.some((hit) => exactBarcodeMatch(barcode, hit.barcode))) break;
    if (hits.length >= MATCH_VARIANT_CAP) break;
  }
  return orderGcdMatchHits(hits, barcode).slice(0, MATCH_VARIANT_CAP);
}

/**
 * The issue `cover` field is that issue's scan (a variant has its own, not the parent's).
 * An empty string stays a placeholder. `gcdDetails` still leaves imageUrl null so backfill does not download scans.
 */
export function gcdHit(issue: GcdIssueRow): MatchHit {
  const coverUrl = issue.coverUrl?.trim() ? issue.coverUrl : null;
  return {
    source: "gcd",
    id: issue.id,
    seriesId: issue.seriesId,
    series: issue.seriesName,
    issueNo: issue.number,
    variant: issue.variant,
    coverDate: issue.coverDate,
    publisher: issue.publisher,
    coverUrl,
    covers: coverUrl ? [{ label: "Cover", imageUrl: coverUrl }] : [],
    barcode: issue.barcode,
    isbn: issue.isbn ?? null,
    price: issue.price,
    onSaleDate: issue.onSaleDate,
    coverPageUrl: gcdCoverHref(issue.id),
  };
}

/**
 * Load one GCD issue from an id or comics.org URL, plus the other variant issues
 * in that family. Variant issues are separate records: `variant_of` is the parent
 * issue URL and `variant_name` is the label. The series payload lists every sibling
 * in `active_issues` / `issue_descriptors`. `/api/series/{id}/issues/` is not a
 * real route. Fetches stay inside the same rate-limited client, capped per family.
 */
export async function loadGcdIssueHits(input: string, catalog: GcdCatalog = createGcdCatalog()): Promise<MatchHit[]> {
  const id = parseGcdIssueRef(input);
  if (!id) return [];
  const issue = await catalog.issue(id);
  if (!issue) return [];
  const family = [issue];
  if (issue.seriesId && catalog.seriesById) {
    const series = await catalog.seriesById(issue.seriesId);
    if (series) {
      issue.seriesYear = issue.seriesYear ?? series.yearBegan;
      const siblings = gcdFamilyIssueIds(series, issue).filter((siblingId) => siblingId !== issue.id).slice(0, MATCH_VARIANT_CAP - 1);
      for (const siblingId of siblings) {
        const row = await catalog.issue(siblingId);
        if (!row || !inVariantFamily(issue, row)) continue;
        row.seriesYear = row.seriesYear ?? series.yearBegan;
        const descriptor = series.issues.find((item) => item.id === siblingId)?.descriptor ?? "";
        family.push(withDescriptor(row, descriptor));
      }
    }
  }
  const requested = family.filter((row) => row.id === id);
  const rest = family.filter((row) => row.id !== id);
  return [...requested, ...rest].map((row) => gcdHit(row));
}

/** Descriptor stem shared by a base issue and its `1 [Variant]` siblings. Blank and `[Foil]` share one family. */
export function gcdIssueFamilyKey(descriptor: string): string {
  const head = descriptor.trim().replace(/\s*\[.*$/, "").trim().toLowerCase();
  if (head && head !== "[nn]" && head !== "nn") return head;
  return "[nn]";
}

export function gcdVariantSiblingIds(series: GcdSeriesRow, issueId: string): string[] {
  const self = series.issues.find((item) => item.id === issueId);
  if (!self) return [];
  const key = gcdIssueFamilyKey(self.descriptor);
  return series.issues.filter((item) => item.id !== issueId && gcdIssueFamilyKey(item.descriptor) === key).map((item) => item.id);
}

/**
 * Issue ids to compare with a shelf barcode. GCD has no barcode route, so the
 * numbered issue's variants are checked first, then the rest of that series.
 */
function gcdBarcodeIssueIds(series: GcdSeriesRow, familyIds: ReadonlySet<string>): string[] {
  const ids = [...familyIds];
  for (const issue of series.issues) {
    if (ids.length >= MATCH_VARIANT_CAP) break;
    if (!ids.includes(issue.id)) ids.push(issue.id);
  }
  return ids;
}

/**
 * Issue ids for one Match-panel row family: the numbered issue plus every cover variant.
 * A one-shot often stores Cover A as `[Cover A]` with no issue number, and only one
 * sibling as `1 [Cover C]`. Those bare labels belong to that single issue.
 */
export function gcdMatchIssueIds(series: GcdSeriesRow, issueNo: string | null, coverYear: number | null): string[] {
  const seeds = issueIdsFor(series, issueNo, coverYear, true);
  const stems = descriptorStems(series);
  const wanted = (issueNo ?? "").trim().toLowerCase();
  const onlyStem = stems.size === 1 ? [...stems][0] ?? null : null;
  const wholeSeriesIsOneIssue = stems.size <= 1 && series.issues.length > 0 && series.issues.length <= MATCH_VARIANT_CAP;
  if (wholeSeriesIsOneIssue && (seeds.length > 0 || stems.size === 0 || wanted === "" || wanted === "1" || onlyStem === wanted)) {
    return series.issues.map((issue) => issue.id);
  }
  const ids = [...seeds];
  if (onlyStem && onlyStem === wanted) {
    for (const issue of series.issues) {
      if (descriptorStem(issue.descriptor) == null && !ids.includes(issue.id)) ids.push(issue.id);
    }
  }
  return ids.slice(0, MATCH_VARIANT_CAP);
}

/** Parent plus every sibling of a loaded issue, including bare `[Cover A]` labels on a one-shot. */
export function gcdFamilyIssueIds(series: GcdSeriesRow, anchor: GcdIssueRow): string[] {
  const number = anchor.number && !/^\[?nn\]?$/i.test(anchor.number.trim()) ? anchor.number : null;
  const matched = gcdMatchIssueIds(series, number ?? (series.issues.length <= MATCH_VARIANT_CAP ? "1" : null), anchor.coverYear);
  if (matched.includes(anchor.id)) return matched;
  const ids = [anchor.id, ...gcdVariantSiblingIds(series, anchor.id).filter((id) => id !== anchor.id)];
  return ids.slice(0, MATCH_VARIANT_CAP);
}

/** Exact full barcode, add-on included, floats to the top. Other rows keep their order. */
export function orderGcdMatchHits<T extends { barcode?: string | null }>(hits: T[], barcode: string | null | undefined): T[] {
  return hits
    .map((hit, index) => ({ hit, index, exact: exactBarcodeMatch(barcode, hit.barcode) ? 0 : 1 }))
    .sort((a, b) => a.exact - b.exact || a.index - b.index)
    .map((row) => row.hit);
}

function descriptorStem(descriptor: string): string | null {
  const key = gcdIssueFamilyKey(descriptor);
  return key === "[nn]" ? null : key;
}

function descriptorStems(series: GcdSeriesRow): Set<string> {
  return new Set(series.issues.map((issue) => descriptorStem(issue.descriptor)).filter((stem): stem is string => Boolean(stem)));
}

function inVariantFamily(anchor: GcdIssueRow, row: GcdIssueRow): boolean {
  if (row.id === anchor.id) return true;
  const parent = anchor.variantOf || anchor.id;
  if (row.id === parent) return true;
  if (row.variantOf) return row.variantOf === parent;
  return !anchor.variantOf;
}

/**
 * A variant issue wins over its parent when the shelf barcode matches that variant
 * and not the parent, or when the shelf variant name matches it and the barcode does not disagree.
 * A shared barcode stays on the parent unless the variant name also matches.
 */
export function matchingGcdVariant(issues: GcdIssueRow[], comic: CoverQuery): GcdIssueRow | null {
  const variants = issues.filter((issue) => Boolean(issue.variantOf) || Boolean(issue.variant?.trim()));
  const parents = issues.filter((issue) => !variants.includes(issue));
  const parentExact = parents.some((issue) => barcodeAgreement(comic.barcode, issue.barcode) === "exact");
  const exact = variants.filter((issue) => barcodeAgreement(comic.barcode, issue.barcode) === "exact");
  if (exact.length === 1 && !parentExact) return exact[0] ?? null;
  const pool = exact.length > 1 ? exact : variants;
  const named = pool.filter(
    (issue) =>
      variantNamesMatch(comic, issue.variant) &&
      !barcodeConflicts(comic.barcode, issue.barcode) &&
      (!parentExact || barcodeAgreement(comic.barcode, issue.barcode) === "exact"),
  );
  if (named.length === 1) return named[0] ?? null;
  return null;
}

function shouldScanVariants(comic: CoverQuery, first: GcdIssueRow, available: number): boolean {
  if (available <= 1) return false;
  if (comic.barcode && barcodeAgreement(comic.barcode, first.barcode) !== "exact") return true;
  const wanted = [comic.variant, comic.variantDescription].filter((part) => part?.trim()).join(" ");
  if (wanted.trim() && !variantNamesMatch(comic, first.variant)) return true;
  return false;
}

function variantNamesMatch(comic: CoverQuery, variant: string | null | undefined): boolean {
  const want = normName([comic.variant, comic.variantDescription].filter(Boolean).join(" "));
  const got = normName(variant ?? "");
  if (want.length < 3 || got.length < 3) return false;
  return want.includes(got) || got.includes(want);
}

function barcodeConflicts(copy: string | null | undefined, issue: string | null | undefined): boolean {
  const want = (copy ?? "").replace(/\D/g, "");
  const got = (issue ?? "").replace(/\D/g, "");
  if (want.length < 12 || got.length < 12) return false;
  return barcodeAgreement(copy, issue) == null;
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
  if (!comic.series.trim() || (!issueNo && comic.coverYear == null)) {
    return { status: "unmatched", reason: "GCD needs a series and issue number.", score: 0 };
  }
  const names = comic.series.includes("/")
    ? gcdSlashMatchNames(comic.series, edition.searchNames)
    : uniqueNames(edition.searchNames.length > 0 ? edition.searchNames : [comic.series], catalogNameQueries(comic.series));
  let best: CoverDecision = { status: "unmatched", reason: `No GCD series named ${comic.series}.`, score: 0 };
  let fetched = 0;
  for (const name of names) {
    const seriesRows = await readSeries(catalog, name);
    const picked = pickSeries(seriesRows, name, edition.reprint ? (comic.releaseYear ?? comic.coverYear) : comic.coverYear);
    for (const series of picked) {
      const issueIds = issueIdsFor(series, issueNo, comic.coverYear, edition.reprint).slice(0, VARIANT_FETCH_CAP);
      const batch: GcdIssueRow[] = [];
      let scan = false;
      for (const id of issueIds) {
        if (!scan && batch.length >= 2) break;
        if (!scan && fetched >= 4) return best;
        if (fetched >= VARIANT_FETCH_CAP) break;
        fetched += 1;
        const issue = await catalog.issue(id);
        if (!issue) continue;
        issue.seriesYear = issue.seriesYear ?? series.yearBegan;
        const descriptor = series.issues.find((item) => item.id === id)?.descriptor ?? "";
        batch.push(withDescriptor(issue, descriptor));
        if (batch.length === 1) scan = shouldScanVariants(comic, batch[0], issueIds.length);
        if (scan && matchingGcdVariant(batch, comic)) break;
      }
      if (batch.length === 0) continue;
      const oneIssue = knownIssueCount(series) === 1 && seriesSoloTitle(comic.series, series.name);
      const preferred = scan ? matchingGcdVariant(batch, comic) : null;
      const ordered = preferred ? [preferred, ...batch.filter((issue) => issue.id !== preferred.id)] : batch;
      for (const issue of ordered) {
        const decision = chooseGcd([issue], scoringCopy(comic, series), scoredIssueNo(issueNo, issue.number, comic.coverYear), oneIssue);
        if (decision.status === "matched") return decision;
        if (decision.score > best.score) best = decision;
      }
      if (scan ? fetched >= VARIANT_FETCH_CAP : fetched >= 4) return best;
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
    barcode: issue.barcode ?? isbnText(issue.isbn),
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
  const rawNames = trade ? gcdCollectedQueries(seriesName) : catalogNameQueries(seriesName, { broad: true });
  const names = seriesName.includes("/") ? gcdSlashMatchNames(seriesName, rawNames) : slashSafeNames(rawNames);
  const issueCap = trade ? 12 : 8;
  for (const name of names) {
    if (exact.length > 0 || fetched >= issueCap) break;
    const rows = await readSeries(catalog, name);
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
  for (const name of slashSafeNames(edition.searchNames)) {
    const seriesRows = await readSeries(catalog, name);
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
  const preferred = matchingGcdVariant(issues, comic);
  if (preferred) {
    const decision = chooseFacsimileIssue([toHit(preferred)], comic, "gcd");
    if (decision.status === "matched") return decision;
  }
  return chooseFacsimileIssue(issues.map(toHit), comic, "gcd");
}

/** Facsimile series from the core name, then the issues inside them, best barcode first. */
export async function collectGcdFacsimileIssues(
  comic: CoverQuery,
  catalog: GcdCatalog,
  options?: { every?: boolean },
): Promise<GcdIssueRow[]> {
  const edition = detectEdition(comic);
  const issueNo = edition.issueNo || "";
  if (!comic.series.trim() || !issueNo) return [];
  const releaseYear = comic.releaseYear ?? yearFromDate(comic.releaseDate);
  let fallback: GcdIssueRow[] = [];
  let fetched = 0;
  for (const name of slashSafeNames(gcdFacsimileQueries(comic.series, issueNo)).slice(0, 8)) {
    if (fetched >= 8) break;
    const rows = await readSeries(catalog, name);
    const kept = keepFacsimileSeries(rows, issueNo, releaseYear);
    if (kept.length === 0) continue;
    const loaded = await loadFacsimileIssues(kept, catalog);
    fetched += loaded.length;
    if (loaded.length === 0) continue;
    if (options?.every) return loaded.map((row) => row.issue);
    const ranked = rankFacsimileIssues(loaded, comic);
    const best = ranked[0]?.rank ?? 3;
    const picked = ranked.filter((row) => row.rank === best).map((row) => row.issue);
    if (best <= 1 || !comic.barcode) return picked;
    if (fallback.length === 0) fallback = picked;
  }
  return fallback;
}

function chooseGcd(issues: GcdIssueRow[], comic: CoverQuery, issueNo: string, oneIssue = false): CoverDecision {
  const hits = issues.map((issue) => ({ ...toHit(issue), oneIssue }));
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
    oneIssue: issue.oneIssue,
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

/** Slash titles: rare part and slash-removed form first, then other safe catalog queries. A bare franchise such as Batman is left out. */
function gcdSlashMatchNames(wanted: string, extras: string[] = []): string[] {
  const head = gcdSeriesNameQueries(wanted);
  const tail = slashSafeNames([...extras, ...catalogNameQueries(wanted)]).filter((name) => !gcdBareFranchise(name) && !name.includes("/"));
  return uniqueNames(head, tail);
}

function slashSafeNames(names: string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length < 3 || /[\\/#?%]/.test(trimmed)) return;
    if (out.some((item) => item.toLowerCase() === trimmed.toLowerCase())) return;
    out.push(trimmed);
  };
  for (const name of names) {
    if (name.includes("/")) {
      for (const query of gcdSeriesNameQueries(name)) add(query);
    } else add(name);
  }
  return out;
}

async function readSeries(catalog: GcdCatalog, name: string): Promise<GcdSeriesRow[]> {
  try {
    return await catalog.seriesByName(name);
  } catch (error) {
    if (error instanceof GcdNameMiss) return [];
    throw error;
  }
}

/** Publisher URLs on a short name-matched list. Each lookup is one limited GCD request. */
async function resolvePublishers(rows: GcdSeriesRow[], catalog: GcdCatalog): Promise<GcdSeriesRow[]> {
  if (!catalog.publisher) return rows;
  const cache = new Map<string, string | null>();
  const resolved: GcdSeriesRow[] = [];
  for (const row of rows) {
    if (row.publisher || !row.publisherId) {
      resolved.push(row);
      continue;
    }
    let name = cache.get(row.publisherId);
    if (name === undefined) {
      if (cache.size >= 8) {
        resolved.push(row);
        continue;
      }
      name = await catalog.publisher(row.publisherId);
      cache.set(row.publisherId, name);
    }
    resolved.push({ ...row, publisher: name });
  }
  return resolved;
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

function knownIssueCount(series: GcdSeriesRow): number | null {
  if (series.issueCount != null) return series.issueCount;
  if (/one[\s-]?shot/i.test(series.format ?? "")) return 1;
  return series.issues.length > 0 ? series.issues.length : null;
}

/** A one-issue Special, Annual, or One-Shot is scored under its own title. */
function scoringCopy(comic: CoverQuery, series: GcdSeriesRow): CoverQuery {
  if (knownIssueCount(series) === 1 && seriesSoloTitle(comic.series, series.name)) return { ...comic, series: series.name };
  return comic;
}

/**
 * Issue 1, or a blank issue, may be the cover year on a series numbered by year.
 * The catalog number is what the scorer compares.
 */
function scoredIssueNo(shelfIssue: string, catalogNumber: string, coverYear: number | null): string {
  const shelf = shelfIssue.trim();
  if (coverYear != null && (shelf === "" || sameIssueNumber(shelf, "1")) && sameIssueNumber(catalogNumber, String(coverYear))) {
    return catalogNumber;
  }
  return shelfIssue;
}

function issueIdsFor(series: GcdSeriesRow, issueNo: string | null, coverYear: number | null, reprint: boolean): string[] {
  const raw = (issueNo ?? "").trim();
  const open = raw === "" || sameIssueNumber(raw, "1");
  if (!open) return issuesFor(series, raw, reprint);
  const direct = raw ? issuesFor(series, raw, reprint) : [];
  if (direct.length > 0) return direct;
  if (coverYear != null) {
    const byYear = issuesFor(series, String(coverYear), reprint);
    if (byYear.length > 0) return byYear;
  }
  if (!raw) return series.issues.map((issue) => issue.id);
  return [];
}

function pickSeries(rows: GcdSeriesRow[], name: string, year: number | null): GcdSeriesRow[] {
  const wanted = norm(name);
  const named = rows.filter((row) => {
    const got = norm(row.name);
    return (
      seriesNamesMatch(name, row.name) ||
      (knownIssueCount(row) === 1 && seriesSoloTitle(name, row.name)) ||
      got === wanted ||
      got.includes(wanted) ||
      wanted.includes(got)
    );
  });
  const exact = named.filter((row) => seriesNamesMatch(name, row.name) || norm(row.name) === wanted);
  const pool = exact.length > 0 ? exact : named;
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

function isbnText(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 10 && digits.length !== 13) return null;
  return raw;
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
