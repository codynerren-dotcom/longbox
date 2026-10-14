"use server";

import { revalidatePath } from "next/cache";
import { refetchOneCover, startCoverBackfillInBackground } from "@/lib/covers/run";
import { prisma } from "@/lib/db";
import { changedKeys } from "@/lib/log/query";
import { logSettingsChange } from "@/lib/log/events";
import { pruneLogs } from "@/lib/log/write";
import { DEMO_WISHLIST, isDemoCoreId, searchIndexFields } from "@/lib/maintenance";
import { preferencesFromForm } from "@/lib/settings/preferences";
import { getPreferences, savePreferences, setCoversPaused } from "@/lib/settings/service";

export type LibraryState = { status: "idle" | "ok" | "error"; message: string };

export async function savePreferencesAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  try {
    const current = await getPreferences();
    const next = preferencesFromForm(formData, current);
    await savePreferences(next);
    await logSettingsChange(changedKeys(current, next));
    await pruneLogs(true);
    revalidatePath("/", "layout");
    return { status: "ok", message: "Preferences saved." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save preferences." };
  }
}

export async function runCoversAction(): Promise<LibraryState> {
  const result = await startCoverBackfillInBackground();
  revalidatePath("/settings");
  revalidatePath("/covers");
  if (result === "unconfigured") {
    return { status: "error", message: "Add Metron username and password, then start the backfill again." };
  }
  if (result === "busy") return { status: "ok", message: "A cover backfill is already running." };
  return { status: "ok", message: "Backfill started." };
}

export async function pauseCoversAction(): Promise<LibraryState> {
  const before = await getPreferences();
  await setCoversPaused(true);
  if (!before.covers.paused) await logSettingsChange(["covers.paused"]);
  revalidatePath("/settings");
  revalidatePath("/covers");
  return { status: "ok", message: "Pause requested. The backfill stops after the current issue." };
}

export async function refetchCoverAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  try {
    const found = await findComic(formData);
    if ("error" in found) return { status: "error", message: found.error };
    const message = await refetchOneCover(found.id);
    revalidatePath("/", "layout");
    return { status: message.startsWith("Fetched") ? "ok" : "error", message };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not re-fetch that cover." };
  }
}

export async function rebuildSearchIndexAction(): Promise<LibraryState> {
  const comics = await prisma.comic.findMany({
    select: { id: true, series: true, issueNo: true, seriesSort: true, issueSort: true },
  });
  const dirty = comics.filter((comic) => {
    const next = searchIndexFields(comic);
    return next.seriesSort !== comic.seriesSort || next.issueSort !== comic.issueSort;
  });
  const chunkSize = 40;
  for (let index = 0; index < dirty.length; index += chunkSize) {
    const chunk = dirty.slice(index, index + chunkSize);
    await prisma.$transaction(chunk.map((comic) => prisma.comic.update({ where: { id: comic.id }, data: searchIndexFields(comic) })));
  }
  revalidatePath("/", "layout");
  return { status: "ok", message: `Checked ${comics.length} issues. Updated ${dirty.length} sort fields.` };
}

export async function clearDemoAction(_prev: LibraryState, formData: FormData): Promise<LibraryState> {
  if (formData.get("confirmDemo") !== "on") {
    return { status: "error", message: "Confirm the demo wipe before clearing." };
  }
  const comics = await prisma.comic.findMany({ select: { id: true, coreComicId: true } });
  const ids = comics.filter((comic) => isDemoCoreId(comic.coreComicId)).map((comic) => comic.id);
  const deleted = ids.length === 0 ? { count: 0 } : await prisma.comic.deleteMany({ where: { id: { in: ids } } });
  const wishlist = await prisma.wishlistItem.deleteMany({
    where: {
      OR: DEMO_WISHLIST.map((item) => ({
        series: item.series,
        publisher: item.publisher,
        issueNo: item.issueNo,
        notes: item.notes,
      })),
    },
  });
  revalidatePath("/", "layout");
  return { status: "ok", message: `Removed ${deleted.count} demo comics and ${wishlist.count} seed wishlist rows.` };
}

async function findComic(formData: FormData): Promise<{ id: string } | { error: string }> {
  const id = String(formData.get("comicId") ?? "").trim();
  if (id) {
    const comic = await prisma.comic.findUnique({ where: { id }, select: { id: true } });
    return comic ?? { error: "No issue with that id." };
  }
  const series = String(formData.get("series") ?? "").trim();
  const issue = String(formData.get("issue") ?? "").trim();
  if (!series || !issue) return { error: "Enter a series and issue, or an issue id." };
  const matches = await prisma.comic.findMany({
    where: {
      series: { equals: series, mode: "insensitive" },
      OR: [{ issueNo: issue }, { issue: issue }],
    },
    select: { id: true },
    take: 5,
  });
  if (matches.length === 0) return { error: "No issue matched that series and number." };
  if (matches.length > 1) return { error: `Several issues match. Use an issue id: ${matches.map((match) => match.id).join(", ")}` };
  return { id: matches[0].id };
}
