"use server";

import { revalidatePath } from "next/cache";
import { linkIssueToCatalog, loadIssueCovers, repullLinkedCover, searchIssueCatalog, unlinkIssueCatalog } from "@/lib/catalog/link-issue";
import type { MatchCover, MatchHit } from "@/lib/catalog/match-hits";
import type { CatalogSource } from "@/lib/catalog/manual-link";
import { refreshIssueFromMetron } from "@/lib/covers/run";
import { prisma } from "@/lib/db";
import { setReadState } from "@/lib/mutations";
import { seriesRouteId } from "@/lib/series";

async function refreshIssue(comicId: string) {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { series: true, publisher: true, coreSeriesId: true },
  });
  revalidatePath(`/issues/${comicId}`);
  revalidatePath("/");
  revalidatePath("/collection");
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
  revalidatePath(`/issues/${id}`);
  revalidatePath("/");
  revalidatePath("/collection");
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
