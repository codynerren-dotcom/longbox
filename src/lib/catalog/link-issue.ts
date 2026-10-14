import { Prisma } from "@prisma/client";
import { comicVineDetails, linkUpdate, unlinkUpdate } from "@/lib/catalog/link-plan";
import { mapComicVineMatchHit, mapMetronMatchHit, variantCoversFrom, type MatchCover, type MatchHit } from "@/lib/catalog/match-hits";
import { manualLinkJson, readManualLink, withoutUserCover, type CatalogSource } from "@/lib/catalog/manual-link";
import { createGcdCatalog } from "@/lib/catalog/gcd";
import { linkMetronFromForeignIds } from "@/lib/covers/cross-link-run";
import { comicVineIssue, metronCovers, searchComicVineMatches, searchMetronMatches } from "@/lib/catalog/match-search";
import { gcdDetails, gcdHit, searchGcdMatches } from "@/lib/covers/gcd-match";
import { coverPublicPath } from "@/lib/covers/backfill";
import { mapMetronDetails, METRON_FIELDS, type MetronField } from "@/lib/covers/enrich";
import { acquireBackfillLock, backfillLockHeld, coverFileKey, downloadCover, releaseBackfillLock } from "@/lib/covers/files";
import { fetchMetronIssueBody, metronBasicAuth, metronTransport } from "@/lib/covers/metron-client";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import { getSettings } from "@/lib/settings/service";

export type MatchSearchResult = { ok: true; hits: MatchHit[] } | { ok: false; message: string };

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
      writer: true,
      artist: true,
      coverArtist: true,
      characters: true,
      teams: true,
      imprint: true,
      seriesYear: true,
      seriesVolume: true,
      releaseDate: true,
    },
  });
}

function currentFields(
  comic: NonNullable<Awaited<ReturnType<typeof comicForLink>>>,
): Partial<Record<MetronField, unknown>> & { gcdIssueId: string | null; gcdSeriesId: string | null } {
  const current: Partial<Record<MetronField, unknown>> = {};
  for (const field of METRON_FIELDS) current[field] = comic[field];
  return { ...current, gcdIssueId: comic.gcdIssueId, gcdSeriesId: comic.gcdSeriesId };
}

function storedLink(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return manualLinkJson(value) ?? Prisma.DbNull;
}

export async function searchIssueCatalog(args: {
  source: CatalogSource;
  query: string;
  barcode: string;
  mode: "query" | "barcode";
}): Promise<MatchSearchResult> {
  const needle = args.mode === "barcode" ? args.barcode.trim() : args.query.trim();
  if (!needle) return { ok: false, message: args.mode === "barcode" ? "Enter a barcode." : "Enter a series or issue." };
  try {
    const hits = args.source === "metron" ? await searchMetron(args) : args.source === "gcd" ? await searchGcdMatches(args.query, args.barcode, args.mode) : await searchComicVine(args);
    if ("ok" in hits) return hits;
    await writeLog({
      level: "info",
      source: logSource(args.source),
      message: `Match search on ${catalogName(args.source)} returned ${hits.length}.`,
      details: { mode: args.mode, count: hits.length },
    });
    return { ok: true, hits };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed.";
    await writeLog({ level: "warn", source: logSource(args.source), message, details: { mode: args.mode } });
    return { ok: false, message };
  }
}

async function searchMetron(args: { query: string; barcode: string; mode: "query" | "barcode" }): Promise<MatchHit[] | MatchSearchResult> {
  if (!(await metronBasicAuth())) return { ok: false, message: "Add a Metron username and password in Settings to search." };
  return searchMetronMatches(await metronTransport(), args.query, args.barcode, args.mode);
}

async function searchComicVine(args: { query: string; barcode: string; mode: "query" | "barcode" }): Promise<MatchHit[] | MatchSearchResult> {
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

async function downloadChosenCover(source: Exclude<CatalogSource, "gcd">, issueId: string, imageUrl: string, primaryUrl: string | null) {
  const prefix = source === "metron" ? "metron" : "cv";
  const file = await downloadCover(imageUrl, coverFileKey(issueId, imageUrl, primaryUrl), undefined, { force: true, prefix });
  return { file, url: coverPublicPath(file), imageUrl };
}

export async function linkIssueToCatalog(args: {
  comicId: string;
  source: CatalogSource;
  hit: MatchHit;
  useCover: boolean;
  fillMissing: boolean;
  coverImageUrl: string | null;
}): Promise<{ ok: boolean; message: string }> {
  if (backfillLockHeld()) return { ok: false, message: "A Metron run is already going. Wait for it to finish." };
  const comic = await comicForLink(args.comicId);
  if (!comic) return { ok: false, message: "That issue is not on the shelf." };
  if (!/^\d+$/.test(args.hit.id) || args.hit.source !== args.source) return { ok: false, message: "Pick a result from that catalog." };
  const label = issueLabel(comic.series, comic.issueNo, comic.issue);
  try {
    const loaded = await loadLinkTarget(args.source, args.hit);
    if (!loaded.ok) return loaded;
    const covers = loaded.covers.length > 0 ? loaded.covers : args.hit.covers;
    const chosen =
      args.coverImageUrl && (covers.some((cover) => cover.imageUrl === args.coverImageUrl) || args.coverImageUrl === args.hit.coverUrl)
        ? args.coverImageUrl
        : covers[0]?.imageUrl ?? args.hit.coverUrl;
    const cover = args.source !== "gcd" && args.useCover && chosen ? await downloadChosenCover(args.source, args.hit.id, chosen, covers[0]?.imageUrl ?? chosen) : null;
    const update = linkUpdate({
      source: args.source,
      hit: loaded.hit,
      current: currentFields(comic),
      fieldSources: comic.fieldSources,
      manualLink: comic.manualLink,
      detail: loaded.detail,
      fillMissing: args.fillMissing,
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
        await writeLog({ level: "warn", source: "metron", message: note, details: { comicId: comic.id } });
      }
    }
    await writeLog({
      level: "info",
      source: logSource(args.source),
      message,
      details: { comicId: comic.id, externalId: args.hit.id, useCover: args.useCover, fillMissing: args.fillMissing, filled: update.filled },
    });
    return { ok: true, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not link this issue.";
    await writeLog({ level: "error", source: logSource(args.source), message, details: { comicId: args.comicId } });
    return { ok: false, message };
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
    return { ok: true, hit: issue ? gcdHit(issue) : hit, detail, covers: [], issueUrl: null, seriesUrl: null, embeddedMetronIssueId: issue?.metronIssueId ?? null };
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

export async function saveChosenCover(comicId: string): Promise<{ ok: boolean; message: string }> {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true, series: true, issue: true, issueNo: true, metronIssueId: true, comicvineIssueId: true, manualLink: true },
  });
  if (!comic) return { ok: false, message: "That issue is not on the shelf." };
  const label = issueLabel(comic.series, comic.issueNo, comic.issue);
  const link = readManualLink(comic.manualLink);
  try {
    const chosen = await chosenImage(link, comic.comicvineIssueId);
    if (!chosen) return { ok: false, message: "Link an issue before re-pulling its cover." };
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
    return { ok: true, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not re-pull the cover.";
    await writeLog({ level: "error", source: "covers/backfill", message, details: { comicId } });
    return { ok: false, message };
  }
}

async function chosenImage(
  link: ReturnType<typeof readManualLink>,
  comicvineIssueId: string | null,
): Promise<{ source: "metron" | "comicvine"; issueId: string; imageUrl: string; primaryUrl: string | null } | null> {
  if (link.coverImageUrl && link.coverSource) {
    const issueId = link.coverSource === "metron" ? link.metronIssueId : link.comicvineIssueId;
    if (issueId) return { source: link.coverSource, issueId, imageUrl: link.coverImageUrl, primaryUrl: link.coverImageUrl };
  }
  if (link.metronIssueId) {
    if (!(await metronBasicAuth())) throw new Error("Add a Metron username and password in Settings to search.");
    const body = await fetchMetronIssueBody(await metronTransport(), link.metronIssueId);
    const imageUrl = body ? mapMetronMatchHit(body)?.coverUrl ?? null : null;
    if (imageUrl) return { source: "metron", issueId: link.metronIssueId, imageUrl, primaryUrl: imageUrl };
  }
  const cvId = link.comicvineIssueId ?? (comicvineIssueId && /^\d+$/.test(comicvineIssueId) ? comicvineIssueId : null);
  if (!cvId) return null;
  const settings = await getSettings();
  if (!settings.comicvine.apiKey) throw new Error("Add a Comic Vine API key in Settings to search.");
  const body = await comicVineIssue(settings.comicvine.apiKey, cvId);
  const imageUrl = body ? variantCoversFrom(body)[0]?.imageUrl ?? null : null;
  if (!imageUrl) return null;
  return { source: "comicvine", issueId: cvId, imageUrl, primaryUrl: imageUrl };
}
