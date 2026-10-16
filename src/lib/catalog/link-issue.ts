import { Prisma } from "@prisma/client";
import { comicVineDetails, linkUpdate, unlinkUpdate } from "@/lib/catalog/link-plan";
import { mapComicVineMatchHit, mapMetronMatchHit, variantCoversFrom, type MatchCover, type MatchHit } from "@/lib/catalog/match-hits";
import { manualLinkJson, matchQuery, readManualLink, shouldSaveCatalogCover, withoutUserCover, type CatalogSource } from "@/lib/catalog/manual-link";
import { createGcdCatalog } from "@/lib/catalog/gcd";
import { limitBlockFromError, limitNotices, type LimitBlock } from "@/lib/catalog/limit-notice";
import { hintFromBlocks, type QueueHint } from "@/lib/catalog/search-queue";
import { linkMetronFromForeignIds } from "@/lib/covers/cross-link-run";
import { comicVineIssue, metronCovers, searchComicVineMatches, searchMetronMatches } from "@/lib/catalog/match-search";
import { gcdDetails, gcdHit, searchGcdMatches } from "@/lib/covers/gcd-match";
import { coverPublicPath } from "@/lib/covers/backfill";
import { mapMetronDetails, METRON_FIELDS, type MetronField } from "@/lib/covers/enrich";
import { acquireBackfillLock, backfillLockHeld, coverFileKey, downloadCover, releaseBackfillLock } from "@/lib/covers/files";
import { fetchMetronIssueBody, metronBasicAuth, metronTransport, sharedMetronLimiter } from "@/lib/covers/metron-client";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import { getSettings } from "@/lib/settings/service";

export type MatchSearchResult =
  | { ok: true; hits: MatchHit[]; notice: string | null; queue: QueueHint | null }
  | { ok: false; message: string; notice: string | null; queue: QueueHint | null };

function limitBlocks(error: unknown): LimitBlock | null {
  return limitBlockFromError(error, sharedMetronLimiter().snapshot());
}

function noticeText(blocks: LimitBlock[], searched: string[]): string | null {
  const text = limitNotices(blocks, searched);
  return text || null;
}

function issueLabel(series: string, issueNo: string | null, issue: string | null): string {
  return `${series} #${issueNo || issue || "?"}`;
}

function catalogName(source: CatalogSource): string {
  if (source === "metron") return "Metron";
  if (source === "gcd") return "GCD";
  return "Comic Vine";
}

function logSource(source: CatalogSource): "metron" | "comicvine" | "gcd" {
  if (source === "metron") return "metron";
  if (source === "gcd") return "gcd";
  return "comicvine";
}

async function comicForLink(id: string) {
  return prisma.comic.findUnique({
    where: { id },
    select: {
      id: true,
      series: true,
      issue: true,
      issueNo: true,
      metronIssueId: true,
      metronSeriesId: true,
      metronIssueUrl: true,
      metronSeriesUrl: true,
      comicvineIssueId: true,
      comicvineSeriesId: true,
      gcdIssueId: true,
      gcdSeriesId: true,
      fieldSources: true,
      manualLink: true,
      coverDate: true,
      coverYear: true,
      title: true,
      storyArc: true,
      plot: true,
      pageCount: true,
      coverPrice: true,
      barcode: true,
      publisher: true,
      variantDescription: true,
      writer: true,
      artist: true,
      coverArtist: true,
      characters: true,
      teams: true,
      imprint: true,
      seriesYear: true,
      seriesVolume: true,
      releaseDate: true,
      collects: true,
    },
  });
}

function currentFields(
  comic: NonNullable<Awaited<ReturnType<typeof comicForLink>>>,
): Partial<Record<MetronField, unknown>> & {
  gcdIssueId: string | null;
  gcdSeriesId: string | null;
  collects: string | null;
  publisher: string | null;
  variantDescription: string | null;
} {
  const current: Partial<Record<MetronField, unknown>> = {};
  for (const field of METRON_FIELDS) current[field] = comic[field];
  return {
    ...current,
    gcdIssueId: comic.gcdIssueId,
    gcdSeriesId: comic.gcdSeriesId,
    collects: comic.collects,
    publisher: comic.publisher,
    variantDescription: comic.variantDescription,
  };
}

function storedLink(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return manualLinkJson(value) ?? Prisma.DbNull;
}

export function mergeShelfSeries(given: string | null | undefined, stored: string | null | undefined): string {
  return given?.trim() || stored?.trim() || "";
}

export async function searchIssueCatalog(args: {
  source: CatalogSource;
  query: string;
  barcode: string;
  mode: "query" | "barcode";
  shelfFormat?: string | null;
  shelfSeries?: string | null;
  facsimile?: boolean;
  comicId?: string | null;
}): Promise<MatchSearchResult> {
  const needle = args.mode === "barcode" ? args.barcode.trim() : args.query.trim();
  if (!needle) return { ok: false, message: args.mode === "barcode" ? "Enter a barcode." : "Enter a series or issue.", notice: null, queue: null };
  const stored = await storedShelf(args);
  const shelfSeries = mergeShelfSeries(args.shelfSeries, stored?.series);
  const query =
    args.mode === "barcode" && !args.query.trim() && shelfSeries
      ? matchQuery({ series: shelfSeries, issueNo: stored?.issueNo, year: null })
      : args.query;
  const rank = (await loadShelfRank(args.comicId)) ?? {};
  const request = { ...args, query, shelfFormat: args.shelfFormat ?? stored?.shelfFormat ?? null, shelfSeries, ...rank };
  try {
    const hits = await searchOne(args.source, request);
    if ("ok" in hits) return { ...hits, notice: null, queue: null };
    await writeLog({
      level: "info",
      source: logSource(args.source),
      message: `Match search on ${catalogName(args.source)} returned ${hits.length}.`,
      details: { mode: args.mode, count: hits.length },
    });
    return { ok: true, hits, notice: null, queue: null };
  } catch (error) {
    const block = limitBlocks(error);
    if (!block) {
      const message = error instanceof Error ? error.message : "Search failed.";
      await writeLog({ level: "warn", source: logSource(args.source), message, details: { mode: args.mode } });
      return { ok: false, message, notice: null, queue: null };
    }
    const blocks = [block];
    const searched: string[] = [];
    const hits: MatchHit[] = [];
    for (const source of otherSources(args.source)) {
      if (!(await sourceReady(source))) continue;
      try {
        const found = await searchOne(source, request);
        if ("ok" in found) continue;
        searched.push(catalogName(source));
        hits.push(...found);
      } catch (otherError) {
        const other = limitBlocks(otherError);
        if (other) blocks.push(other);
      }
    }
    const notice = noticeText(blocks, searched);
    const queue = hintFromBlocks(args.source, blocks, "search");
    await writeLog({
      level: "warn",
      source: logSource(args.source),
      message: notice ?? "Search paused.",
      details: { mode: args.mode, count: hits.length },
    });
    return { ok: true, hits, notice, queue };
  }
}

/** One catalog, no fallback. The queued search uses this so a paused neighbor is not reported as a match. */
export async function searchCatalogSource(args: {
  source: CatalogSource;
  query: string;
  barcode: string;
  mode: "query" | "barcode";
  shelfFormat?: string | null;
  shelfSeries?: string | null;
  facsimile?: boolean;
  comicId?: string | null;
}): Promise<MatchHit[]> {
  const stored = await storedShelf(args);
  const shelfSeries = mergeShelfSeries(args.shelfSeries, stored?.series);
  const query =
    args.mode === "barcode" && !args.query.trim() && shelfSeries
      ? matchQuery({ series: shelfSeries, issueNo: stored?.issueNo, year: null })
      : args.query;
  const rank = await loadShelfRank(args.comicId);
  const found = await searchOne(args.source, {
    query,
    barcode: args.barcode,
    mode: args.mode,
    shelfFormat: args.shelfFormat ?? stored?.shelfFormat ?? null,
    shelfSeries,
    facsimile: args.facsimile,
    publisher: rank?.publisher ?? null,
    country: rank?.country ?? null,
    language: rank?.language ?? null,
  });
  if ("ok" in found) throw new Error(found.message);
  return found;
}

function otherSources(source: CatalogSource): CatalogSource[] {
  return (["gcd", "comicvine", "metron"] as const).filter((item) => item !== source);
}

async function sourceReady(source: CatalogSource): Promise<boolean> {
  if (source === "metron") return Boolean(await metronBasicAuth());
  if (source === "comicvine") return Boolean((await getSettings()).comicvine.apiKey);
  return true;
}

async function searchOne(
  source: CatalogSource,
  args: {
    query: string;
    barcode: string;
    mode: "query" | "barcode";
    shelfFormat?: string | null;
    shelfSeries?: string | null;
    facsimile?: boolean;
    publisher?: string | null;
    country?: string | null;
    language?: string | null;
  },
): Promise<MatchHit[] | { ok: false; message: string }> {
  if (source === "metron") return searchMetron(args);
  if (source === "gcd") {
    return searchGcdMatches(args.query, args.barcode, args.mode, args.shelfFormat, {
      facsimile: args.facsimile,
      shelfSeries: args.shelfSeries,
      publisher: args.publisher,
      country: args.country,
      language: args.language,
    });
  }
  return searchComicVine(args);
}

async function loadShelfRank(comicId: string | null | undefined): Promise<{ publisher: string | null; country: string | null; language: string | null } | null> {
  const id = comicId?.trim() ?? "";
  if (!id) return null;
  const comic = await prisma.comic.findUnique({
    where: { id },
    select: { publisher: true, country: true, language: true },
  });
  if (!comic) return null;
  return { publisher: comic.publisher, country: comic.country, language: comic.language };
}

async function storedShelf(args: {
  comicId?: string | null;
  shelfSeries?: string | null;
  query: string;
  mode: "query" | "barcode";
}): Promise<{ series: string; issueNo: string | null; shelfFormat: string | null } | null> {
  const id = args.comicId?.trim() ?? "";
  if (!id) return null;
  const needsSeries = !args.shelfSeries?.trim();
  const needsIssue = args.mode === "barcode" && !args.query.trim();
  if (!needsSeries && !needsIssue) return null;
  const comic = await prisma.comic.findUnique({
    where: { id },
    select: { series: true, issueNo: true, issue: true, shelfFormat: true },
  });
  if (!comic) return null;
  return { series: comic.series, issueNo: comic.issueNo || comic.issue, shelfFormat: comic.shelfFormat };
}

async function searchMetron(args: {
  query: string;
  barcode: string;
  mode: "query" | "barcode";
  shelfFormat?: string | null;
}): Promise<MatchHit[] | { ok: false; message: string }> {
  if (!(await metronBasicAuth())) return { ok: false, message: "Add a Metron username and password in Settings to search." };
  return searchMetronMatches(await metronTransport(), args.query, args.barcode, args.mode, args.shelfFormat);
}

async function searchComicVine(args: { query: string; barcode: string; mode: "query" | "barcode" }): Promise<MatchHit[] | { ok: false; message: string }> {
  const settings = await getSettings();
  if (!settings.comicvine.apiKey) return { ok: false, message: "Add a Comic Vine API key in Settings to search." };
  return searchComicVineMatches({ apiKey: settings.comicvine.apiKey, query: args.query, barcode: args.barcode, mode: args.mode });
}

export async function loadIssueCovers(source: CatalogSource, issueId: string): Promise<MatchCover[]> {
  if (!/^\d+$/.test(issueId)) return [];
  if (source === "gcd") return [];
  if (source === "metron") {
    if (!(await metronBasicAuth())) return [];
    return metronCovers(await metronTransport(), issueId);
  }
  const settings = await getSettings();
  if (!settings.comicvine.apiKey) return [];
  const body = await comicVineIssue(settings.comicvine.apiKey, issueId);
  return body ? variantCoversFrom(body) : [];
}

function coverPrefix(source: CatalogSource): "metron" | "cv" | "gcd" {
  if (source === "gcd") return "gcd";
  if (source === "comicvine") return "cv";
  return "metron";
}

async function downloadChosenCover(source: CatalogSource, issueId: string, imageUrl: string, primaryUrl: string | null) {
  const file = await downloadCover(imageUrl, coverFileKey(issueId, imageUrl, primaryUrl), undefined, { force: true, prefix: coverPrefix(source) });
  return { file, url: coverPublicPath(file), imageUrl };
}

export async function linkIssueToCatalog(args: {
  comicId: string;
  source: CatalogSource;
  hit: MatchHit;
  useCover: boolean;
  fillMissing: boolean;
  overwrite?: boolean;
  replaceExisting?: boolean;
  coverImageUrl: string | null;
}): Promise<{ ok: boolean; message: string; notice: string | null; queue: QueueHint | null }> {
  if (backfillLockHeld()) return { ok: false, message: "A Metron run is already going. Wait for it to finish.", notice: null, queue: null };
  const comic = await comicForLink(args.comicId);
  if (!comic) return { ok: false, message: "That issue is not on the shelf.", notice: null, queue: null };
  if (!/^\d+$/.test(args.hit.id) || args.hit.source !== args.source) return { ok: false, message: "Pick a result from that catalog.", notice: null, queue: null };
  const label = issueLabel(comic.series, comic.issueNo, comic.issue);
  let crossNotice: string | null = null;
  try {
    const loaded = await loadLinkTarget(args.source, args.hit);
    if (!loaded.ok) return { ...loaded, notice: null, queue: null };
    const covers = loaded.covers.length > 0 ? loaded.covers : loaded.hit.covers;
    const fromLoaded = covers[0]?.imageUrl ?? loaded.hit.coverUrl;
    const chosen =
      args.coverImageUrl && (covers.some((cover) => cover.imageUrl === args.coverImageUrl) || args.coverImageUrl === loaded.hit.coverUrl)
        ? args.coverImageUrl
        : fromLoaded;
    const manual = readManualLink(comic.manualLink);
    const saveCover = shouldSaveCatalogCover({
      useCover: args.useCover,
      userCover: manual.userCover,
      replaceExisting: args.replaceExisting === true,
    });
    const cover = saveCover && chosen ? await downloadChosenCover(args.source, args.hit.id, chosen, covers[0]?.imageUrl ?? chosen) : null;
    const update = linkUpdate({
      source: args.source,
      hit: loaded.hit,
      current: currentFields(comic),
      fieldSources: comic.fieldSources,
      manualLink: comic.manualLink,
      detail: loaded.detail,
      fillMissing: args.fillMissing,
      overwrite: args.overwrite,
      cover,
      issueUrl: loaded.issueUrl,
      seriesUrl: loaded.seriesUrl,
    });
    await prisma.comic.update({ where: { id: comic.id }, data: { ...update.data, manualLink: storedLink(update.data.manualLink) } });
    let message = `Linked ${label} to ${catalogName(args.source)} ${args.hit.id}.`;
    if (args.source === "metron") {
      if (typeof update.data.comicvineIssueId === "string") message += ` Stored Comic Vine ${update.data.comicvineIssueId}.`;
      if (typeof update.data.gcdIssueId === "string") message += ` Stored GCD ${update.data.gcdIssueId}.`;
    }
    if ((args.source === "comicvine" || args.source === "gcd") && !comic.metronIssueId && !readManualLink(comic.manualLink).metronIssueId) {
      try {
        const follow = await linkMetronFromForeignIds(comic.id, loaded.embeddedMetronIssueId);
        if (follow) message = `${message} ${follow}`;
      } catch (error) {
        const note = error instanceof Error ? error.message : "Metron cross-link failed.";
        const block = limitBlocks(error);
        if (block) crossNotice = noticeText([block], []);
        await writeLog({ level: "warn", source: "metron", message: crossNotice ?? note, details: { comicId: comic.id } });
      }
    }
    await writeLog({
      level: "info",
      source: logSource(args.source),
      message,
      details: { comicId: comic.id, externalId: args.hit.id, useCover: args.useCover, fillMissing: args.fillMissing, filled: update.filled },
    });
    return { ok: true, message, notice: crossNotice, queue: null };
  } catch (error) {
    const block = limitBlocks(error);
    const notice = block ? noticeText([block], []) : null;
    const queue = block ? hintFromBlocks(args.source, [block], "relink") : null;
    const message = notice ?? (error instanceof Error ? error.message : "Could not link this issue.");
    await writeLog({ level: "error", source: logSource(args.source), message, details: { comicId: args.comicId } });
    return { ok: false, message, notice, queue };
  }
}

async function loadLinkTarget(
  source: CatalogSource,
  hit: MatchHit,
): Promise<
  | { ok: true; hit: MatchHit; detail: ReturnType<typeof mapMetronDetails>; covers: MatchCover[]; issueUrl: string | null; seriesUrl: string | null; embeddedMetronIssueId: string | null }
  | { ok: false; message: string }
> {
  if (source === "gcd") {
    const issue = await createGcdCatalog().issue(hit.id);
    const detail = issue ? gcdDetails(issue) : null;
    const scan = issue?.coverUrl?.trim() ? issue.coverUrl : null;
    return {
      ok: true,
      hit: issue ? gcdHit(issue) : hit,
      detail,
      covers: scan ? [{ label: "Cover", imageUrl: scan }] : [],
      issueUrl: null,
      seriesUrl: null,
      embeddedMetronIssueId: issue?.metronIssueId ?? null,
    };
  }
  if (source === "metron") {
    if (!(await metronBasicAuth())) return { ok: false, message: "Add a Metron username and password in Settings to search." };
    const body = await fetchMetronIssueBody(await metronTransport(), hit.id);
    const detail = body ? mapMetronDetails(body) : null;
    const mapped = body ? mapMetronMatchHit(body) : null;
    return {
      ok: true,
      hit: mapped ?? hit,
      detail,
      covers: body ? variantCoversFrom(body) : hit.covers,
      issueUrl: detail?.metronIssueUrl ?? null,
      seriesUrl: detail?.metronSeriesUrl ?? null,
      embeddedMetronIssueId: null,
    };
  }
  const settings = await getSettings();
  if (!settings.comicvine.apiKey) return { ok: false, message: "Add a Comic Vine API key in Settings to search." };
  const body = await comicVineIssue(settings.comicvine.apiKey, hit.id);
  const mapped = body ? mapComicVineMatchHit(body) : null;
  const next = mapped ?? hit;
  return {
    ok: true,
    hit: next,
    detail: body ? comicVineDetails(body, next) : null,
    covers: body ? variantCoversFrom(body) : hit.covers,
    issueUrl: null,
    seriesUrl: null,
    embeddedMetronIssueId: null,
  };
}

export async function unlinkIssueCatalog(comicId: string, source: CatalogSource): Promise<{ ok: boolean; message: string }> {
  const comic = await comicForLink(comicId);
  if (!comic) return { ok: false, message: "That issue is not on the shelf." };
  const data = unlinkUpdate({ source, fieldSources: comic.fieldSources, manualLink: comic.manualLink });
  await prisma.comic.update({ where: { id: comic.id }, data: { ...data, manualLink: storedLink(data.manualLink) } });
  const message = `Unlinked ${catalogName(source)} from ${issueLabel(comic.series, comic.issueNo, comic.issue)}.`;
  await writeLog({ level: "info", source: logSource(source), message, details: { comicId } });
  return { ok: true, message };
}

export async function repullLinkedCover(comicId: string): Promise<{ ok: boolean; message: string }> {
  if (backfillLockHeld()) return { ok: false, message: "A Metron run is already going. Wait for it to finish." };
  if (!acquireBackfillLock()) return { ok: false, message: "A Metron run is already going. Wait for it to finish." };
  try {
    return await saveChosenCover(comicId);
  } finally {
    releaseBackfillLock();
  }
}

export async function saveChosenCover(comicId: string): Promise<{ ok: boolean; message: string; notice: string | null }> {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true, series: true, issue: true, issueNo: true, metronIssueId: true, comicvineIssueId: true, gcdIssueId: true, manualLink: true },
  });
  if (!comic) return { ok: false, message: "That issue is not on the shelf.", notice: null };
  const label = issueLabel(comic.series, comic.issueNo, comic.issue);
  const link = readManualLink(comic.manualLink);
  try {
    const chosen = await chosenImage(link, comic.comicvineIssueId, comic.gcdIssueId);
    if (!chosen) return { ok: false, message: "Link an issue before re-pulling its cover.", notice: null };
    const saved = await downloadChosenCover(chosen.source, chosen.issueId, chosen.imageUrl, chosen.primaryUrl);
    const next = withoutUserCover(link);
    await prisma.comic.update({
      where: { id: comic.id },
      data: {
        coverFile: saved.file,
        coverUrl: saved.url,
        coverStatus: "matched",
        coverNote: null,
        coverCheckedAt: new Date(),
        manualLink: manualLinkJson(next) ?? Prisma.DbNull,
      },
    });
    const message = `Re-pulled the cover for ${label}.`;
    await writeLog({ level: "info", source: "covers/backfill", message, details: { comicId, source: chosen.source } });
    return { ok: true, message, notice: null };
  } catch (error) {
    const block = limitBlocks(error);
    const notice = block ? noticeText([block], []) : null;
    const message = notice ?? (error instanceof Error ? error.message : "Could not re-pull the cover.");
    await writeLog({ level: "error", source: "covers/backfill", message, details: { comicId } });
    return { ok: false, message, notice };
  }
}

async function chosenImage(
  link: ReturnType<typeof readManualLink>,
  comicvineIssueId: string | null,
  gcdIssueId: string | null,
): Promise<{ source: CatalogSource; issueId: string; imageUrl: string; primaryUrl: string | null } | null> {
  if (link.coverImageUrl && link.coverSource) {
    const issueId = link.coverSource === "metron" ? link.metronIssueId : link.coverSource === "comicvine" ? link.comicvineIssueId : link.gcdIssueId;
    if (issueId) return { source: link.coverSource, issueId, imageUrl: link.coverImageUrl, primaryUrl: link.coverImageUrl };
  }
  if (link.metronIssueId) {
    if (!(await metronBasicAuth())) throw new Error("Add a Metron username and password in Settings to search.");
    const body = await fetchMetronIssueBody(await metronTransport(), link.metronIssueId);
    const imageUrl = body ? mapMetronMatchHit(body)?.coverUrl ?? null : null;
    if (imageUrl) return { source: "metron", issueId: link.metronIssueId, imageUrl, primaryUrl: imageUrl };
  }
  const cvId = link.comicvineIssueId ?? (comicvineIssueId && /^\d+$/.test(comicvineIssueId) ? comicvineIssueId : null);
  if (cvId) {
    const settings = await getSettings();
    if (!settings.comicvine.apiKey) throw new Error("Add a Comic Vine API key in Settings to search.");
    const body = await comicVineIssue(settings.comicvine.apiKey, cvId);
    const imageUrl = body ? variantCoversFrom(body)[0]?.imageUrl ?? null : null;
    if (imageUrl) return { source: "comicvine", issueId: cvId, imageUrl, primaryUrl: imageUrl };
  }
  const gcdId = link.gcdIssueId ?? (gcdIssueId && /^\d+$/.test(gcdIssueId) ? gcdIssueId : null);
  if (!gcdId) return null;
  const issue = await createGcdCatalog().issue(gcdId);
  const scan = issue?.coverUrl?.trim() ? issue.coverUrl : null;
  if (!scan) return null;
  return { source: "gcd", issueId: gcdId, imageUrl: scan, primaryUrl: scan };
}
