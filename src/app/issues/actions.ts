"use server";

import { unlink } from "node:fs/promises";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { linkIssueToCatalog, loadIssueCovers, repullLinkedCover, searchIssueCatalog, unlinkIssueCatalog } from "@/lib/catalog/link-issue";
import type { MatchCover, MatchHit } from "@/lib/catalog/match-hits";
import type { CatalogSource } from "@/lib/catalog/manual-link";
import { refreshIssueFromMetron } from "@/lib/covers/run";
import { readCrop } from "@/lib/covers/photo";
import { previewUserPhoto, revertToMetronCover, saveUserCover } from "@/lib/covers/user-cover";
import { coverFilePath, coversDir } from "@/lib/covers/files";
import { prisma } from "@/lib/db";
import { choiceList, issueLabel, RAW_CHOICES, KEY_LEVELS } from "@/lib/issue-fields";
import { planIssueEdit } from "@/lib/issue-edit";
import { logCopyRemoved, logIssueEdited } from "@/lib/log/events";
import { copiesOf } from "@/lib/shelf-copies";
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
  shelfFormat?: string | null;
  facsimile?: boolean;
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

export async function uploadCoverAction(
  comicId: string,
  formData: FormData,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const file = formData.get("photo");
  if (!(file instanceof File)) return { ok: false, message: "Choose a photo first." };
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await saveUserCover({
      comicId,
      bytes,
      rotation: Number(formData.get("rotation") ?? 0),
      crop: readCrop({
        x: formData.get("x"),
        y: formData.get("y"),
        width: formData.get("width"),
        height: formData.get("height"),
      }),
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save that cover." };
  }
  await refreshIssue(comicId);
  return { ok: true };
}

export async function previewCoverAction(formData: FormData): Promise<{ ok: true; dataUrl: string } | { ok: false; message: string }> {
  const file = formData.get("photo");
  if (!(file instanceof File)) return { ok: false, message: "Choose a photo first." };
  try {
    const jpeg = await previewUserPhoto(Buffer.from(await file.arrayBuffer()));
    return { ok: true, dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not read that photo." };
  }
}

/** Deletes one shelf row. Sibling copies of the same comic stay. */
export async function removeCopyAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const comic = await prisma.comic.findUnique({ where: { id } });
  if (!comic) return;
  const siblings = await copiesOf(comic);
  const nextId = siblings.find((copy) => copy.id !== id)?.id ?? null;
  const coverFile = comic.coverFile;
  await prisma.comic.delete({ where: { id } });
  await releaseCoverFile(coverFile);
  await logCopyRemoved(issueLabel(comic.series, comic.issueNo), id);
  revalidatePath("/");
  revalidatePath("/collection");
  revalidatePath("/keys");
  revalidatePath("/series");
  revalidatePath("/boxes", "layout");
  revalidatePath("/logs");
  revalidatePath(`/series/${encodeURIComponent(seriesRouteId(comic))}`);
  revalidatePath(`/issues/${id}`);
  if (nextId) revalidatePath(`/issues/${nextId}`);
  redirect(nextId ? `/issues/${nextId}` : `/series/${encodeURIComponent(seriesRouteId(comic))}`);
}

async function releaseCoverFile(coverFile: string | null) {
  if (!coverFile) return;
  const stillUsed = await prisma.comic.count({ where: { coverFile } });
  if (stillUsed > 0) return;
  const file = coverFilePath(coversDir(), coverFile);
  if (!file) return;
  try {
    await unlink(file);
  } catch {
    // The file may already be gone.
  }
}

export async function revertCoverAction(comicId: string): Promise<{ ok: boolean; message: string }> {
  const result = await revertToMetronCover(comicId);
  if (result.ok) await refreshIssue(comicId);
  return result;
}
