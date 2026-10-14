"use server";

import { revalidatePath } from "next/cache";
import { linkIssueToCatalog, loadIssueCovers, repullLinkedCover, searchIssueCatalog, unlinkIssueCatalog } from "@/lib/catalog/link-issue";
import type { MatchCover, MatchHit } from "@/lib/catalog/match-hits";
import type { CatalogSource } from "@/lib/catalog/manual-link";
import { refreshIssueFromMetron } from "@/lib/covers/run";
import { prisma } from "@/lib/db";
import { choiceList, issueLabel, RAW_CHOICES, KEY_LEVELS } from "@/lib/issue-fields";
import { planIssueEdit } from "@/lib/issue-edit";
import { logIssueEdited } from "@/lib/log/events";
import { setReadState } from "@/lib/mutations";
import { seriesRouteId } from "@/lib/series";
import { getPreferences } from "@/lib/settings/service";
import type { Prisma } from "@prisma/client";

async function refreshIssue(comicId: string) {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { series: true, publisher: true, coreSeriesId: true },
  });
  revalidatePath(`/issues/${comicId}`);
  revalidatePath("/");
  revalidatePath("/collection");
  revalidatePath("/keys");
  revalidatePath("/boxes", "layout");
  revalidatePath("/logs");
  if (comic) revalidatePath(`/series/${encodeURIComponent(seriesRouteId(comic))}`);
}

export async function setReadAction(formData: FormData): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = String(formData.get("id") ?? "");
  const read = String(formData.get("read") ?? "") === "true";
  const readDate = String(formData.get("readDate") ?? "");
  if (!id) return { ok: false, error: "Missing issue." };
  try {
    await setReadState(id, read, read ? readDate || null : null);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not update read state." };
  }
  await refreshIssue(id);
  return { ok: true };
}

export async function saveIssueAction(
  comicId: string,
  raw: Record<string, string>,
): Promise<{ ok: true } | { ok: false; errors: { field: string; message: string }[] }> {
  if (!comicId) return { ok: false, errors: [{ field: "series", message: "Missing issue." }] };
  const [comic, prefs] = await Promise.all([
    prisma.comic.findUnique({ where: { id: comicId } }),
    getPreferences(),
  ]);
  if (!comic) return { ok: false, errors: [{ field: "series", message: "This issue is no longer on the shelf." }] };
  const lists = {
    categories: choiceList(prefs.collection.keyCategories, comic.keyCategory ?? ""),
    companies: choiceList(prefs.collection.gradingCompanies, comic.gradingCompany ?? ""),
    rawOrSlabbed: choiceList(RAW_CHOICES, comic.rawOrSlabbed ?? ""),
    keyLevels: choiceList(KEY_LEVELS, comic.keyLevel ?? ""),
  };
  const planned = planIssueEdit(comic, raw, comic.fieldSources, lists);
  if (!planned.ok) return planned;
  if (planned.changed.length === 0) return { ok: true };
  await prisma.comic.update({ where: { id: comicId }, data: planned.data as Prisma.ComicUpdateInput });
  const series = "series" in planned.data && typeof planned.data.series === "string" ? planned.data.series : comic.series;
  const issueNo = "issueNo" in planned.data ? (planned.data.issueNo == null ? null : String(planned.data.issueNo)) : comic.issueNo;
  await logIssueEdited(issueLabel(series, issueNo), comicId, planned.changed);
  await refreshIssue(comicId);
  return { ok: true };
}

export async function refreshFromMetronAction(comicId: string): Promise<{ ok: boolean; message: string }> {
  const result = await refreshIssueFromMetron(comicId);
  if (result.ok) await refreshIssue(comicId);
  return result;
}

export async function searchMatchesAction(args: {
  source: CatalogSource;
  query: string;
  barcode: string;
  mode: "query" | "barcode";
}): Promise<{ ok: true; hits: MatchHit[] } | { ok: false; message: string }> {
  return searchIssueCatalog(args);
}

export async function loadMatchCoversAction(source: CatalogSource, issueId: string): Promise<MatchCover[]> {
  return loadIssueCovers(source, issueId);
}

export async function linkMatchAction(args: {
  comicId: string;
  source: CatalogSource;
  hit: MatchHit;
  useCover: boolean;
  fillMissing: boolean;
  coverImageUrl: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const result = await linkIssueToCatalog(args);
  if (result.ok) await refreshIssue(args.comicId);
  return result;
}

export async function unlinkMatchAction(comicId: string, source: CatalogSource): Promise<{ ok: boolean; message: string }> {
  const result = await unlinkIssueCatalog(comicId, source);
  if (result.ok) await refreshIssue(comicId);
  return result;
}

export async function repullCoverAction(comicId: string): Promise<{ ok: boolean; message: string }> {
  const result = await repullLinkedCover(comicId);
  if (result.ok) await refreshIssue(comicId);
  return result;
}
