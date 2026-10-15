import { parseComicBarcode } from "@/lib/barcode";
import {
  detectEdition,
  labelMatchesPrinting,
  printingArtistHint,
  printingOrdinal,
  printingNumberFromText,
  scoreCandidate,
  stripIssueVariant,
  type EditionProfile,
  type MatchCandidate,
} from "@/lib/covers/edition";
import type { CoverDecision, CoverLookup, CoverQuery, MetronIssueHit, MetronSeriesHit, MetronSeriesQuery } from "@/lib/covers/types";
import {
  catalogNameQueries,
  isbnDigits,
  isCollected,
  metronCollectedTitle,
  metronSeriesType,
  normalizeSeriesName,
  parseShelfSeries,
  resolveShelfFormat,
  seriesLooksCollected,
  seriesNamesMatch,
  seriesTitleFits,
  tradeSearchSeries,
  volumeNumber,
  type ShelfFormat,
} from "@/lib/shelf-format";

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

export function narrowSeries(
  hits: MetronSeriesHit[],
  comic: CoverQuery,
  hints?: { volume?: number | null; yearBegan?: number | null },
): MetronSeriesHit[] {
  const wanted = normName(comic.series);
  if (!wanted) return [];
  const exact = hits.filter((hit) => normName(hit.name) === wanted || seriesNamesMatch(comic.series, hit.name));
  let rows = exact;
  if (rows.length === 0) {
    const trailing = hits.filter((hit) => seriesTitleFits(comic.series, hit.name));
    if (trailing.length > 0) {
      const shortest = Math.min(...trailing.map((hit) => normalizeSeriesName(hit.name).length));
      rows = trailing.filter((hit) => normalizeSeriesName(hit.name).length === shortest);
    }
  }
  if (rows.length === 0) return [];
  if (hints?.yearBegan != null) {
    const dated = rows.filter((hit) => hit.yearBegan === hints.yearBegan);
    if (dated.length > 0) rows = dated;
  }
  if (hints?.volume != null) {
    const volumed = rows.filter((hit) => hit.volume === hints.volume);
    if (volumed.length > 0) rows = volumed;
  }
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

function uniqueSearchNames(first: string[], second: string[]): string[] {
  const names: string[] = [];
  for (const name of [...first, ...second]) {
    const trimmed = name.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    if (names.some((item) => item.toLowerCase() === trimmed.toLowerCase())) continue;
    names.push(trimmed);
  }
  return names;
}

function issueToken(comic: CoverQuery): string {
  return (comic.issueNo || comic.issue || "").trim();
}

function labelFor(comic: CoverQuery, issueNo: string): string {
  const year = comic.coverYear != null ? ` (${comic.coverYear})` : "";
  return `${comic.series} #${issueNo || "?"}${year}`;
}

function candidateFrom(hit: MetronIssueHit): MatchCandidate {
  return {
    seriesName: hit.seriesName,
    issueNo: hit.number,
    variant: hit.variant ?? hit.label,
    coverYear: hit.coverYear,
    releaseYear: hit.releaseYear ?? null,
    seriesYear: hit.seriesYear ?? null,
    upc: hit.upc ?? null,
    publisher: hit.publisher ?? null,
    storeDate: hit.storeDate ?? null,
  };
}

const VARIANT_COVER_WORDS = ["foil", "virgin", "sketch", "incentive", "ratio"];

export function applyVariantCover(copy: CoverQuery, issue: MetronIssueHit): MetronIssueHit {
  const text = `${copy.variantDescription ?? ""} ${copy.variant ?? ""}`.toLowerCase();
  const covers = issue.covers ?? [];
  for (const word of VARIANT_COVER_WORDS) {
    if (!text.includes(word)) continue;
    const cover = covers.find((item) => item.label.toLowerCase().includes(word));
    if (!cover) continue;
    return { ...issue, imageUrl: cover.imageUrl, variant: issue.variant ?? cover.label };
  }
  return issue;
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function sameUpc(barcode: string | null | undefined, upc: string | null | undefined): boolean {
  const left = digitsOf(barcode);
  const right = digitsOf(upc);
  return left.length >= 12 && left === right;
}

/** The copy's UPC plus its 5-digit add-on. A 12-digit prefix does not count. */
function carriesFullBarcode(barcode: string | null | undefined, upc: string | null | undefined): boolean {
  const parsed = barcode ? parseComicBarcode(barcode) : null;
  if (!parsed?.addon || parsed.addon.length !== 5) return false;
  const digits = digitsOf(upc);
  return digits.length >= parsed.combined.length && digits.startsWith(parsed.combined);
}

/** Both codes are long enough to compare, and neither is the other plus an add-on. */
function barcodeDisagrees(barcode: string | null | undefined, upc: string | null | undefined): boolean {
  const left = digitsOf(barcode);
  const right = digitsOf(upc);
  if (left.length < 12 || right.length < 12) return false;
  if (left === right) return false;
  return !(left.startsWith(right) || right.startsWith(left));
}

function dedupeHits(hits: MetronIssueHit[]): MetronIssueHit[] {
  const seen = new Set<string>();
  const rows: MetronIssueHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    rows.push(hit);
  }
  return rows;
}

export function chooseFacsimileIssue(hits: MetronIssueHit[], comic: CoverQuery, via: "barcode" | "series" | "gcd"): CoverDecision {
  const edition = detectEdition(comic);
  const labeled = `${comic.series} #${edition.issueNo || comic.issueNo || "?"}`;
  const ranked = dedupeHits(hits)
    .map((issue) => {
      const adjusted = applyVariantCover(comic, issue);
      let scored = scoreCandidate({ ...comic, issueNo: edition.issueNo || comic.issueNo }, candidateFrom(adjusted));
      if (via === "gcd" && barcodeDisagrees(comic.barcode, adjusted.upc)) {
        scored = { ...scored, auto: false, blocked: scored.blocked ?? "Barcode does not match." };
      }
      return { issue: adjusted, scored, exactUpc: sameUpc(comic.barcode, adjusted.upc) };
    })
    .filter((row) => row.scored.blocked == null && row.scored.auto)
    .filter((row) => via === "gcd" || Boolean(row.issue.imageUrl))
    .sort((a, b) => Number(b.exactUpc) - Number(a.exactUpc) || b.scored.score - a.scored.score);

  const exact = ranked.filter((row) => row.exactUpc);
  const pool = exact.length === 1 ? exact : ranked;
  const best = pool[0];
  const next = pool[1];
  if (best && (!next || best.exactUpc || best.scored.score >= next.scored.score + 12)) {
    return { status: "matched", via, issue: best.issue, score: best.scored.score };
  }
  if (ranked.length > 1) {
    return { status: "unmatched", reason: `Several facsimile issues match ${labeled}.`, score: ranked[0]?.scored.score ?? 0 };
  }
  return { status: "unmatched", reason: `No facsimile issue for ${labeled}.`, score: 0 };
}

function facsimileSeriesRows(hits: MetronSeriesHit[], query: string, publisher: string | null): MetronSeriesHit[] {
  const tokens = normName(query)
    .split(" ")
    .filter((word) => word && word !== "facsimile" && word !== "edition");
  let rows = hits.filter((hit) => {
    const name = normName(hit.name);
    if (!name.includes("facsimile")) return false;
    return tokens.every((word) => name.includes(word));
  });
  if (publisher) {
    const published = rows.filter((hit) => publishersMatch(publisher, hit.publisher));
    rows = published;
  }
  return rows.slice(0, 4);
}

async function resolveFacsimileCover(comic: CoverQuery, edition: EditionProfile, lookup: CoverLookup): Promise<CoverDecision> {
  const barcode = comic.barcode ? parseComicBarcode(comic.barcode) : null;
  const collected: MetronIssueHit[] = [];
  if (barcode) {
    collected.push(...(await lookup.issuesByUpc(barcode.combined)));
    if (barcode.upc && barcode.upc !== barcode.combined) {
      const base = await lookup.issuesByUpc(barcode.upc);
      collected.push(...base);
      if (base.length === 0) collected.push(...(await lookup.issuesByUpcPrefix(barcode.upc)));
    }
    const decision = chooseFacsimileIssue(collected, comic, "barcode");
    if (decision.status === "matched") return decision;
  }

  if (edition.facsimileSearches.length === 0) {
    return { status: "unmatched", reason: `No facsimile issue for ${comic.series}.`, score: 0 };
  }

  let best: CoverDecision = { status: "unmatched", reason: `No facsimile issue for ${comic.series} #${edition.issueNo || "?"}.`, score: 0 };
  for (const search of edition.facsimileSearches) {
    const found = await lookup.searchSeries(search.series);
    const candidates = facsimileSeriesRows(found, search.series, comic.publisher);
    for (const candidate of candidates) {
      const issues = await lookup.issuesForSeries(candidate.id, search.issueNo, null);
      const decision = chooseFacsimileIssue(
        issues.map((issue) => ({
          ...issue,
          seriesYear: issue.seriesYear ?? candidate.yearBegan,
          publisher: issue.publisher ?? candidate.publisher,
        })),
        comic,
        "series",
      );
      if (decision.status === "matched") return decision;
      if (decision.score > best.score) best = decision;
    }
  }
  return best;
}

export function chooseIssue(
  hits: MetronIssueHit[],
  comic: CoverQuery,
  issueNo: string,
  via: "barcode" | "series" | "gcd",
): CoverDecision {
  const name = labelFor(comic, issueNo);
  if (hits.length === 0) {
    return { status: "unmatched", reason: `No Metron issue for ${name}.`, score: 0 };
  }

  if (via === "barcode" && hits.length > 1) {
    const full = hits.filter((hit) => carriesFullBarcode(comic.barcode, hit.upc));
    if (full.length === 1 && full[0]?.imageUrl) {
      const scored = scoreCandidate({ ...comic, issueNo: full[0].number || issueNo }, candidateFrom(full[0]));
      if (!scored.blocked) {
        return { status: "matched", via, issue: full[0], score: scored.score };
      }
    }
    if (issueNo) {
      const numbered = hits.filter((hit) => sameIssueNumber(hit.number, issueNo));
      if (numbered.length === 1 && numbered[0]?.imageUrl) {
        const scored = scoreCandidate({ ...comic, issueNo }, candidateFrom(numbered[0]));
        if (!scored.blocked) {
          return { status: "matched", via, issue: numbered[0], score: scored.score };
        }
      }
    }
  }

  let rows = hits;
  if (issueNo) {
    const numbered = rows.filter((hit) => sameIssueNumber(hit.number, issueNo));
    if (numbered.length > 0) rows = numbered;
    else if (via === "series") return { status: "unmatched", reason: `No Metron issue for ${name}.`, score: 0 };
  }

  const ranked = rows
    .map((issue) => ({ issue, scored: scoreCandidate({ ...comic, issueNo: issueNo || comic.issueNo }, candidateFrom(issue)) }))
    .sort((a, b) => b.scored.score - a.scored.score || Number(Boolean(b.issue.imageUrl)) - Number(Boolean(a.issue.imageUrl)));
  const best = ranked[0];
  const next = ranked[1];
  if (!best) return { status: "unmatched", reason: `No Metron issue for ${name}.`, score: 0 };
  if (best.scored.auto && (!next || !next.scored.auto || best.scored.score >= next.scored.score + 12)) {
    if (!best.issue.imageUrl && via !== "gcd") {
      return { status: "unmatched", reason: `Metron issue ${best.issue.id} has no cover image.`, score: best.scored.score };
    }
    return { status: "matched", via, issue: best.issue, score: best.scored.score };
  }
  if (via === "barcode" && rows.length > 1 && ranked.filter((row) => row.scored.auto).length !== 1) {
    return { status: "unmatched", reason: `Several Metron issues share this barcode (${rows.map((hit) => hit.id).join(", ")}).`, score: best.scored.score };
  }
  const why = best.scored.blocked ?? `score ${best.scored.score} is below the match line`;
  return { status: "unmatched", reason: `${name}: ${why}.`, score: best.scored.score };
}

function printingIssueNumber(value: string): string {
  const leading = value.trim().match(/^#?\s*(\d+)/);
  return stripIssueVariant(leading?.[1] ?? value).number;
}

/** The printing cover to save. A missing variant stays unconfirmed so the 1st-print image is not used. */
export function savedPrintingCover(
  comic: CoverQuery,
  issue: MetronIssueHit,
  extraCovers?: Array<{ label: string; imageUrl: string }>,
): { active: boolean; imageUrl: string | null; note: string | null; printing: number | null } {
  const edition = detectEdition(comic);
  if (edition.kind !== "printing" || edition.printing == null) {
    return { active: false, imageUrl: issue.imageUrl, note: null, printing: null };
  }
  const covers: Array<{ label: string; imageUrl: string }> = [];
  const seen = new Set<string>();
  for (const cover of [...(issue.covers ?? []), ...(extraCovers ?? [])]) {
    if (seen.has(cover.imageUrl)) continue;
    seen.add(cover.imageUrl);
    covers.push(cover);
  }
  const selected = selectPrintingCover({ ...issue, covers }, edition.printing, printingArtistHint(comic.variantDescription));
  if (selected.review || !selected.issue.imageUrl) {
    const ordinal = printingOrdinal(edition.printing);
    return {
      active: true,
      imageUrl: null,
      note: selected.review ?? `No ${ordinal} printing cover on this issue. The 1st-print cover was left off.`,
      printing: null,
    };
  }
  return { active: true, imageUrl: selected.issue.imageUrl, note: null, printing: edition.printing };
}

function artistFits(label: string, artist: string | null): boolean {
  if (!artist) return true;
  const hay = normName(label);
  return artist.split(/\s+/).every((word) => hay.includes(normName(word)));
}

/** Pick the printing variant. The main "Cover" image stays unused. */
export function selectPrintingCover(
  issue: MetronIssueHit,
  printing: number,
  artist: string | null,
): { issue: MetronIssueHit; review: string | null } {
  const own = [issue.variant, issue.label].filter((part) => part && !/^cover$/i.test(part)).join(" ");
  if (labelMatchesPrinting(own, printing) && artistFits(own, artist)) {
    return { issue, review: null };
  }
  const covers = (issue.covers ?? []).filter((cover) => labelMatchesPrinting(cover.label, printing));
  const fitting = covers.filter((cover) => artistFits(cover.label, artist));
  const plain = fitting.filter((cover) => !printingArtistHint(cover.label));
  const pool = artist ? fitting : plain.length > 0 ? plain : [];
  if (pool.length === 1) {
    return { issue: { ...issue, imageUrl: pool[0].imageUrl, variant: pool[0].label, label: pool[0].label }, review: null };
  }
  const ordinal = printingOrdinal(printing);
  if (pool.length > 1) {
    return { issue: { ...issue, imageUrl: null }, review: `Several ${ordinal} printing covers match. The 1st-print cover was left off.` };
  }
  return { issue: { ...issue, imageUrl: null }, review: `No ${ordinal} printing cover on this issue. The 1st-print cover was left off.` };
}

export function choosePrintingIssue(hits: MetronIssueHit[], comic: CoverQuery, via: "barcode" | "series" | "gcd"): CoverDecision {
  const edition = detectEdition(comic);
  const printing = edition.printing;
  const labeled = `${comic.series} #${edition.issueNo || comic.issueNo || "?"}`;
  if (printing == null) return { status: "unmatched", reason: `No later printing for ${labeled}.`, score: 0 };
  const number = edition.issueNo || stripIssueVariant(comic.issueNo).number;
  let rows = dedupeHits(hits);
  if (number) {
    const numbered = rows.filter((hit) => sameIssueNumber(printingIssueNumber(hit.number), number));
    if (numbered.length === 0) return { status: "unmatched", reason: `No later printing for ${labeled}.`, score: 0 };
    rows = numbered;
  }
  rows = rows.filter((hit) => {
    const found = printingNumberFromText(`${hit.variant ?? ""} ${hit.label ?? ""}`);
    return found == null || found === printing;
  });
  const artist = printingArtistHint(comic.variantDescription);
  const ranked = rows
    .map((issue) => {
      const own = labelMatchesPrinting(`${issue.variant ?? ""} ${issue.label ?? ""}`, printing);
      const scored = scoreCandidate({ ...comic, issueNo: number }, candidateFrom(issue));
      return { issue, scored, exactUpc: sameUpc(comic.barcode, issue.upc), own };
    })
    .filter((row) => row.scored.blocked == null && row.scored.auto)
    .sort((a, b) => Number(b.own) - Number(a.own) || Number(b.exactUpc) - Number(a.exactUpc) || b.scored.score - a.scored.score);
  const best = ranked[0];
  const next = ranked[1];
  if (!best || (next && !best.own && !best.exactUpc && best.scored.score < next.scored.score + 12)) {
    if (ranked.length > 1) return { status: "unmatched", reason: `Several issues match ${labeled}.`, score: ranked[0]?.scored.score ?? 0 };
    return { status: "unmatched", reason: `No later printing for ${labeled}.`, score: best?.scored.score ?? 0 };
  }
  const selected = selectPrintingCover(best.issue, printing, artist);
  return { status: "matched", via, issue: selected.issue, score: best.scored.score, coverReview: selected.review };
}

async function resolvePrintingCover(comic: CoverQuery, edition: EditionProfile, lookup: CoverLookup): Promise<CoverDecision> {
  const barcode = comic.barcode ? parseComicBarcode(comic.barcode) : null;
  const collected: MetronIssueHit[] = [];
  if (barcode) {
    collected.push(...(await lookup.issuesByUpc(barcode.combined)));
    if (barcode.upc && barcode.upc !== barcode.combined) {
      const base = await lookup.issuesByUpc(barcode.upc);
      collected.push(...base);
      if (base.length === 0) collected.push(...(await lookup.issuesByUpcPrefix(barcode.upc)));
    }
    const decision = choosePrintingIssue(collected, comic, "barcode");
    if (decision.status === "matched") return decision;
  }
  const issueNo = edition.issueNo || "";
  if (!comic.series.trim() || !issueNo) {
    return { status: "unmatched", reason: `No later printing for ${comic.series}.`, score: 0 };
  }
  let best: CoverDecision = { status: "unmatched", reason: `No later printing for ${comic.series} #${issueNo}.`, score: 0 };
  for (const name of edition.searchNames) {
    const found = await lookup.searchSeries(name);
    let candidates = narrowSeries(found, { ...comic, series: name, coverYear: comic.releaseYear ?? comic.coverYear });
    if (candidates.length === 0) candidates = narrowSeries(found, { ...comic, series: name, coverYear: null });
    for (const candidate of candidates.slice(0, 4)) {
      let issues = await lookup.issuesForSeries(candidate.id, issueNo, comic.releaseYear ?? comic.coverYear);
      if (issues.length === 0) issues = await lookup.issuesForSeries(candidate.id, issueNo, null);
      const decision = choosePrintingIssue(
        issues.map((issue) => ({
          ...issue,
          seriesYear: issue.seriesYear ?? candidate.yearBegan,
          publisher: issue.publisher ?? candidate.publisher,
        })),
        comic,
        "series",
      );
      if (decision.status === "matched") return decision;
      if (decision.score > best.score) best = decision;
    }
  }
  return best;
}

async function resolveCollectedCover(comic: CoverQuery, format: ShelfFormat, lookup: CoverLookup): Promise<CoverDecision> {
  const seriesName = tradeSearchSeries(comic.series) || comic.series.trim();
  const scored = { ...comic, series: seriesName };
  const issueNo = volumeNumber(comic.issueNo, comic.issue) || "";
  const typeName = metronSeriesType(format);
  const isbn = isbnDigits(comic.barcode);

  if (isbn) {
    const hits = lookup.issuesByIsbn ? await lookup.issuesByIsbn(isbn) : await lookup.issuesByUpc(isbn);
    if (hits.length > 0) {
      if (!issueNo && hits.length === 1 && hits[0]) {
        return { status: "matched", via: "barcode", issue: hits[0], score: 98 };
      }
      const decision = chooseIssue(hits, scored, issueNo, "barcode");
      if (decision.status === "matched") return decision;
    }
  } else if (comic.barcode) {
    const barcode = parseComicBarcode(comic.barcode);
    if (barcode) {
      let hits = await lookup.issuesByUpc(barcode.combined);
      if (hits.length === 0 && barcode.upc && barcode.upc !== barcode.combined) {
        hits = await lookup.issuesByUpcPrefix(barcode.upc);
      }
      if (hits.length > 0) {
        const decision = chooseIssue(hits, scored, issueNo, "barcode");
        if (decision.status === "matched") return decision;
      }
    }
  }

  if (!seriesName) {
    return { status: "unmatched", reason: "A collected edition needs a series name.", score: 0 };
  }

  let found: MetronSeriesHit[] = [];
  for (const name of catalogNameQueries(seriesName, { broad: true })) {
    const rows = typeName && lookup.searchSeriesByType
      ? await lookup.searchSeriesByType(name, typeName)
      : (await lookup.searchSeries(name)).filter((row) => seriesLooksCollected(row.name, format) || metronCollectedTitle(row.name, format));
    const named = rows.filter((row) => seriesNamesMatch(seriesName, row.name));
    if (named.length > 0) {
      found = named;
      break;
    }
  }
  if (found.length === 0) {
    const kind = typeName ?? "collected";
    return { status: "unmatched", reason: `No Metron ${kind} series named ${seriesName}.`, score: 0 };
  }
  if (!issueNo) {
    return { status: "unmatched", reason: `No Metron ${typeName ?? "collected"} issue for ${seriesName}.`, score: 0 };
  }

  const candidates = found.slice(0, 4);
  const matched: CoverDecision[] = [];
  let best: CoverDecision = { status: "unmatched", reason: `No Metron volume ${issueNo} in ${seriesName}.`, score: 0 };
  for (const candidate of candidates) {
    let issues = await lookup.issuesForSeries(candidate.id, issueNo, comic.coverYear);
    if (issues.length === 0 && comic.coverYear != null) issues = await lookup.issuesForSeries(candidate.id, issueNo, null);
    const decision = chooseIssue(
      issues.map((issue) => ({
        ...issue,
        seriesYear: issue.seriesYear ?? candidate.yearBegan,
        publisher: issue.publisher ?? candidate.publisher,
      })),
      scored,
      issueNo,
      "series",
    );
    if (decision.status === "matched") matched.push(decision);
    else if (decision.score > best.score) best = decision;
  }
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) {
    return { status: "unmatched", reason: `Several Metron ${typeName ?? "collected"} series named ${seriesName} have volume ${issueNo}.`, score: matched[0].score };
  }
  return best;
}

export async function resolveCover(comic: CoverQuery, lookup: CoverLookup): Promise<CoverDecision> {
  const shelf = resolveShelfFormat(comic);
  if (isCollected(shelf)) return resolveCollectedCover(comic, shelf, lookup);
  const edition = detectEdition(comic);
  if (edition.kind === "facsimile") return resolveFacsimileCover(comic, edition, lookup);
  if (edition.kind === "printing") return resolvePrintingCover(comic, edition, lookup);
  const issueNo = issueToken(comic);
  const barcode = comic.barcode ? parseComicBarcode(comic.barcode) : null;

  if (barcode) {
    let hits = await lookup.issuesByUpc(barcode.combined);
    if (hits.length === 0 && barcode.upc && barcode.upc !== barcode.combined) {
      hits = await lookup.issuesByUpcPrefix(barcode.upc);
    }
    if (hits.length > 0) {
      const decision = chooseIssue(hits, comic, issueNo, "barcode");
      if (decision.status === "matched") return decision;
      if (hits.length > 1 && decision.reason.includes("Several Metron issues share this barcode")) return decision;
    }
  }

  if (!comic.series.trim() || !issueNo) {
    return { status: "unmatched", reason: "No barcode and no series plus issue number to search.", score: 0 };
  }

  const parsed = parseShelfSeries(comic.series);
  const hints = { volume: parsed.volume, yearBegan: parsed.yearBegan };
  const seriesFilters: MetronSeriesQuery | undefined =
    parsed.volume != null || parsed.yearBegan != null ? { volume: parsed.volume, yearBegan: parsed.yearBegan } : undefined;
  const editionNames = (edition.searchNames.length > 0 ? edition.searchNames : [comic.series]).map((entry) => parseShelfSeries(entry).name);
  const names = uniqueSearchNames(editionNames, catalogNameQueries(parsed.name || comic.series));
  let best: CoverDecision = { status: "unmatched", reason: `No Metron series named ${comic.series}.`, score: 0 };
  let sawSeries = false;

  const consider = async (name: string): Promise<CoverDecision | null> => {
    const query = seriesFilters && !/\b(?:facsimile|reprint|omnibus|anniversary|believers)\b/i.test(name) ? seriesFilters : undefined;
    let found = await lookup.searchSeries(name, query);
    if (found.length === 0 && query) found = await lookup.searchSeries(name);
    const year = edition.reprint ? (comic.releaseYear ?? comic.coverYear) : comic.coverYear;
    let candidates = narrowSeries(found, { ...comic, series: name, coverYear: year }, hints);
    if (candidates.length === 0 && edition.reprint) candidates = narrowSeries(found, { ...comic, series: name, coverYear: null }, hints);
    if (candidates.length === 0) return null;
    sawSeries = true;
    if (candidates.length > 4) {
      best = { status: "unmatched", reason: `Several Metron series named ${name}.`, score: best.score };
      return null;
    }
    const matched: CoverDecision[] = [];
    for (const candidate of candidates) {
      let issues = await lookup.issuesForSeries(candidate.id, issueNo, year);
      if (issues.length === 0 && year != null) issues = await lookup.issuesForSeries(candidate.id, issueNo, null);
      const decision = chooseIssue(
        issues.map((issue) => ({
          ...issue,
          seriesYear: issue.seriesYear ?? candidate.yearBegan,
          publisher: issue.publisher ?? candidate.publisher,
        })),
        comic,
        issueNo,
        "series",
      );
      if (decision.status === "matched") matched.push(decision);
      else if (decision.score > best.score) best = decision;
    }
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) {
      return { status: "unmatched", reason: `Several Metron series named ${name} have #${issueNo}.`, score: matched[0].score };
    }
    return null;
  };

  for (const name of names) {
    const decision = await consider(name);
    if (decision) return decision;
  }
  // "Ewoks" does not prefix-match a catalog title "The Ewoks".
  if (!sawSeries && parsed.name && !/\s/.test(parsed.name)) {
    const decision = await consider(`The ${parsed.name}`);
    if (decision) return decision;
  }
  return best;
}
