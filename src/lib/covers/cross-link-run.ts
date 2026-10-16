import type { Prisma } from "@prisma/client";
import { comicVineIssue, comicVineVolumeStartYear } from "@/lib/catalog/match-search";
import { matchHitFromIssue, type MatchHit } from "@/lib/catalog/match-hits";
import { readManualLink, stripLockedCover } from "@/lib/catalog/manual-link";
import { createGcdCatalog, GcdBudgetError } from "@/lib/catalog/gcd";
import { coverPublicPath } from "@/lib/covers/backfill";
import { blankCrossIds, crossForeignFromComicVine, crossLinkDownloadsCover, crossLinkLine, lookupCrossIssue, type CrossCopy, type CrossForeign, type CrossLookup, type CrossResult, type CrossVia } from "@/lib/covers/cross-link";
import { writePrintingCover } from "@/lib/covers/facsimile-years";
import { savedPrintingCover } from "@/lib/covers/match";
import { planEnrichment, type MetronDetails } from "@/lib/covers/enrich";
import { downloadCover } from "@/lib/covers/files";
import { fetchMetronIssueRecord, metronBasicAuth, metronIssuesByCrossId, metronIssuesByNameOnce, metronTransport, type MetronTransport } from "@/lib/covers/metron-client";
import { MetronBudgetError, type MetronIssueHit } from "@/lib/covers/types";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import { getPreferences, getSettings } from "@/lib/settings/service";

export type ForeignLinkOutcome = {
  line: string | null;
  hits: MatchHit[];
  candidateNote: string | null;
};

const emptyOutcome: ForeignLinkOutcome = { line: null, hits: [], candidateNote: null };

const copySelect = {
  id: true,
  series: true,
  issue: true,
  issueNo: true,
  metronIssueId: true,
  metronSeriesId: true,
  comicvineIssueId: true,
  comicvineSeriesId: true,
  gcdIssueId: true,
  gcdSeriesId: true,
  coverFile: true,
  coverStatus: true,
  manualLink: true,
  fieldSources: true,
  coverDate: true,
  coverYear: true,
  releaseDate: true,
  title: true,
  storyArc: true,
  plot: true,
  pageCount: true,
  coverPrice: true,
  barcode: true,
  shelfFormat: true,
  variant: true,
  variantDescription: true,
  format: true,
  subtitle: true,
  fullTitle: true,
  publisher: true,
  releaseYear: true,
  writer: true,
  artist: true,
  coverArtist: true,
  characters: true,
  teams: true,
  imprint: true,
  seriesYear: true,
  seriesVolume: true,
} as const;

type CopyRow = Prisma.ComicGetPayload<{ select: typeof copySelect }>;

function toCopy(row: CopyRow, embeddedMetronIssueId?: string | null): CrossCopy {
  const link = readManualLink(row.manualLink);
  return {
    id: row.id,
    series: row.series,
    issueNo: row.issueNo,
    issue: row.issue,
    metronIssueId: row.metronIssueId,
    manualMetronIssueId: link.metronIssueId,
    comicvineIssueId: row.comicvineIssueId,
    gcdIssueId: row.gcdIssueId,
    embeddedMetronIssueId,
    barcode: row.barcode,
    shelfFormat: row.shelfFormat,
    userCover: link.userCover,
    coverFile: row.coverFile,
    coverStatus: row.coverStatus,
  };
}

export function createCrossLookup(transport: MetronTransport): CrossLookup {
  return {
    byComicVine: (id: string) => metronIssuesByCrossId(transport, "cv_id", id),
    byGcd: (id: string) => metronIssuesByCrossId(transport, "gcd_id", id),
    foreignIssue: (via, id) => (via === "gcd_id" ? loadGcdForeign(id) : loadComicVineForeign(id)),
    byName: (query) => metronIssuesByNameOnce(transport, query.name, query.number, query.year, query.seriesType),
  };
}

async function loadGcdForeign(id: string): Promise<CrossForeign | null> {
  try {
    const issue = await createGcdCatalog().issue(id);
    if (!issue?.seriesName || !issue.number) return null;
    return { seriesName: issue.seriesName, number: issue.number, seriesYear: issue.seriesYear, barcode: issue.barcode };
  } catch (error) {
    if (error instanceof GcdBudgetError) throw error;
    return null;
  }
}

async function loadComicVineForeign(id: string): Promise<CrossForeign | null> {
  try {
    const settings = await getSettings();
    const apiKey = settings.comicvine.apiKey?.trim() ?? "";
    if (!apiKey) return null;
    const body = await comicVineIssue(apiKey, id);
    const foreign = body ? crossForeignFromComicVine(body) : null;
    if (!foreign) return null;
    if (foreign.seriesYear != null || !foreign.volumeId) return foreign;
    const year = await comicVineVolumeStartYear(apiKey, foreign.volumeId);
    return year == null ? foreign : { ...foreign, seriesYear: year };
  } catch (error) {
    if (error instanceof Error && error.name === "ComicVineBudgetError") throw error;
    return null;
  }
}

/** Walk every copy that already has a Comic Vine or GCD id and no Metron id. */
export async function crossLinkShelf(log: (line: string) => void = () => undefined): Promise<void> {
  if (!(await metronBasicAuth())) {
    log("Metron is not configured, so Comic Vine and GCD ids were not cross-linked.");
    return;
  }
  const transport = await metronTransport();
  const rows = await prisma.comic.findMany({
    where: { metronIssueId: null, OR: [{ comicvineIssueId: { not: null } }, { gcdIssueId: { not: null } }] },
    orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
    select: copySelect,
  });
  log(`Cross-link pass: ${rows.length} ${rows.length === 1 ? "copy has" : "copies have"} a Comic Vine or GCD id and no Metron id.`);
  for (const row of rows) {
    const outcome = await linkRow(row, transport);
    if (outcome.line) log(outcome.line);
  }
}

/** After a Comic Vine or GCD link, store the matching Metron issue when there isn't one yet. */
export async function linkMetronFromForeignIds(comicId: string, embeddedMetronIssueId?: string | null): Promise<ForeignLinkOutcome> {
  if (!(await metronBasicAuth())) return emptyOutcome;
  const row = await prisma.comic.findUnique({ where: { id: comicId }, select: copySelect });
  if (!row) return emptyOutcome;
  const transport = await metronTransport();
  return linkRow(row, transport, embeddedMetronIssueId);
}

async function linkRow(row: CopyRow, transport: MetronTransport, embeddedMetronIssueId?: string | null): Promise<ForeignLinkOutcome> {
  const copy = toCopy(row, embeddedMetronIssueId);
  const lookup = createCrossLookup(transport);
  const result = await lookupCrossIssue(copy, lookup);
  if (result.status !== "linked") return outcomeFrom(copy, result);
  const saved = await saveCrossLink(row, result.hit, result.via, result.foreignId, transport, Boolean(embeddedMetronIssueId) && result.hit.seriesId == null && result.hit.imageUrl == null);
  if (saved) return { line: saved, hits: [], candidateNote: null };
  if (!embeddedMetronIssueId) return emptyOutcome;
  const retry = await lookupCrossIssue(toCopy(row), lookup);
  if (retry.status !== "linked") return outcomeFrom(copy, retry);
  const line = await saveCrossLink(row, retry.hit, retry.via, retry.foreignId, transport, false);
  return { line, hits: [], candidateNote: null };
}

function outcomeFrom(copy: CrossCopy, result: CrossResult): ForeignLinkOutcome {
  const hits = result.status === "candidates" ? result.hits.map(matchHitFromIssue).filter((hit): hit is MatchHit => hit !== null) : [];
  return {
    line: crossLinkLine(copy, result),
    hits,
    candidateNote: result.status === "candidates" ? result.reason : null,
  };
}

async function saveCrossLink(
  row: CopyRow,
  hit: MetronIssueHit,
  via: CrossVia,
  foreignId: string,
  transport: MetronTransport,
  embeddedOnly: boolean,
): Promise<string | null> {
  const link = readManualLink(row.manualLink);
  if (link.metronIssueId || row.metronIssueId) return null;
  let detail: MetronDetails | null = null;
  try {
    detail = await fetchMetronIssueRecord(transport, hit.id);
  } catch (error) {
    if (error instanceof MetronBudgetError) throw error;
    detail = null;
  }
  if (embeddedOnly && !detail) return null;
  const metronIssueId = detail?.id || hit.id;
  const from = via === "cv_id" ? "Comic Vine" : "GCD";
  const name = `${row.series} #${row.issueNo || row.issue || "?"}`;
  const data: Prisma.ComicUpdateInput = {
    metronIssueId,
    metronSeriesId: detail?.seriesId || hit.seriesId,
    metronIssueUrl: detail?.metronIssueUrl ?? undefined,
    metronSeriesUrl: detail?.metronSeriesUrl ?? undefined,
  };
  const plan = detail && (await getPreferences()).covers.fillMissing ? planEnrichment(row, detail, row.fieldSources) : null;
  if (plan && plan.filled.length > 0) {
    Object.assign(data, plan.patch);
    data.fieldSources = plan.sources;
  }
  if (detail) Object.assign(data, blankCrossIds(row, row.fieldSources, row.manualLink, detail));
  const printing = savedPrintingCover(
    {
      series: row.series,
      issueNo: row.issueNo,
      issue: row.issue,
      coverYear: row.coverYear,
      barcode: row.barcode,
      variant: row.variant,
      variantDescription: row.variantDescription,
      format: row.format,
      subtitle: row.subtitle,
      fullTitle: row.fullTitle,
      title: row.title,
      publisher: row.publisher,
      releaseYear: row.releaseYear,
      releaseDate: row.releaseDate,
      seriesYear: row.seriesYear,
    },
    hit,
    detail?.covers,
  );
  if (crossLinkDownloadsCover(toCopy(row))) {
    const imageUrl = printing.active ? printing.imageUrl : detail?.imageUrl || hit.imageUrl;
    if (printing.active && !imageUrl) {
      data.coverFile = null;
      data.coverUrl = null;
      data.coverStatus = null;
      data.coverNote = printing.note;
      data.coverCheckedAt = new Date();
    } else if (imageUrl) {
      try {
        const file = await downloadCover(imageUrl, metronIssueId);
        data.coverFile = file;
        data.coverUrl = coverPublicPath(file);
        data.coverStatus = "matched";
        data.coverNote = null;
        data.coverCheckedAt = new Date();
      } catch (error) {
        if (error instanceof MetronBudgetError) throw error;
        data.coverNote = error instanceof Error ? error.message : "Could not download the Metron cover.";
        if (printing.active) {
          data.coverFile = null;
          data.coverUrl = null;
          data.coverStatus = null;
        }
      }
    }
  }
  if (link.comicvineIssueId) data.comicvineIssueId = link.comicvineIssueId;
  if (link.gcdIssueId) data.gcdIssueId = link.gcdIssueId;
  stripLockedCover(data, row.manualLink);
  await prisma.comic.update({ where: { id: row.id }, data });
  if (printing.active && crossLinkDownloadsCover(toCopy(row))) {
    await writePrintingCover(row.id, data.coverFile ? printing.printing : null);
  }
  const stored = detail?.comicvineIssueId && data.comicvineIssueId === detail.comicvineIssueId ? ` Stored Comic Vine ${detail.comicvineIssueId}.` : "";
  const storedGcd = detail?.gcdIssueId && data.gcdIssueId === detail.gcdIssueId ? ` Stored GCD ${detail.gcdIssueId}.` : "";
  const message = `${name} linked Metron ${metronIssueId} from ${from} ${foreignId}.${stored}${storedGcd}`;
  await writeLog({
    level: "info",
    source: "metron",
    message,
    details: { comicId: row.id, metronIssueId, via, foreignId, comicvineIssueId: detail?.comicvineIssueId ?? null, gcdIssueId: detail?.gcdIssueId ?? null },
  });
  return message;
}
