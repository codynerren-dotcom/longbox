"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { unlinkIssueCatalog } from "@/lib/catalog/link-issue";
import { readManualLink } from "@/lib/catalog/manual-link";
import { METRON_FIELDS, readFieldSources } from "@/lib/covers/enrich";
import { attachMetronCover, queueCoverRetry, startCoverBackfillInBackground } from "@/lib/covers/run";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";

export type BackfillActionState = {
  status: "idle" | "started" | "busy" | "error";
  message: string;
};

export async function startCoverBackfillAction(): Promise<BackfillActionState> {
  const result = await startCoverBackfillInBackground();
  revalidatePath("/covers");
  if (result === "unconfigured") {
    return { status: "error", message: "Add Metron username and password in Settings, then start the backfill again." };
  }
  if (result === "busy") {
    return { status: "busy", message: "A cover backfill is already running. Refresh in a moment." };
  }
  return { status: "started", message: "Backfill started. Progress stays on this page while you move around the shelf." };
}

export async function retryCoverAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await queueCoverRetry(id);
  revalidatePath("/covers");
}

export async function attachCoverAction(_prev: AttachState, formData: FormData): Promise<AttachState> {
  const id = String(formData.get("id") ?? "");
  const metronIssueId = String(formData.get("metronIssueId") ?? "").trim();
  if (!id) return { status: "error", id, message: "Missing issue." };
  try {
    await attachMetronCover(id, metronIssueId);
    revalidatePath("/covers");
    revalidatePath("/", "layout");
    return { status: "ok", id, message: `Saved Metron ${metronIssueId}.` };
  } catch (error) {
    return { status: "error", id, message: error instanceof Error ? error.message : "Could not save that Metron issue." };
  }
}

export type AttachState = { status: "idle" | "ok" | "error"; id: string; message: string };

export async function unlinkSuspectAction(comicId: string): Promise<{ ok: boolean; message: string }> {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { metronIssueId: true, gcdIssueId: true },
  });
  if (!comic) return { ok: false, message: "That issue is not on the shelf." };
  if (comic.metronIssueId) await unlinkIssueCatalog(comicId, "metron");
  if (comic.gcdIssueId) await unlinkIssueCatalog(comicId, "gcd");
  revalidatePath("/covers");
  revalidatePath(`/issues/${comicId}`);
  return { ok: true, message: "Unlinked. The cover file was left in place." };
}

export async function rematchSuspectAction(comicId: string): Promise<{ ok: boolean; message: string }> {
  const comic = await prisma.comic.findUnique({ where: { id: comicId } });
  if (!comic) return { ok: false, message: "That issue is not on the shelf." };
  const link = readManualLink(comic.manualLink);
  if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId) {
    return { ok: false, message: "This link was chosen by hand. Unlink it first." };
  }
  if (link.userCover) {
    return { ok: false, message: "This cover was uploaded. Unlink the catalog id if you want, and the photo stays." };
  }
  const sources = readFieldSources(comic.fieldSources);
  const data: Prisma.ComicUpdateInput = {
    metronIssueId: null,
    metronSeriesId: null,
    metronIssueUrl: null,
    metronSeriesUrl: null,
    gcdIssueId: null,
    gcdSeriesId: null,
    coverFile: null,
    coverUrl: null,
    coverStatus: null,
    coverNote: null,
    coverCheckedAt: null,
    fieldSources: sources,
  };
  const writable = data as unknown as Record<string, unknown>;
  for (const field of METRON_FIELDS) {
    if (sources[field] !== "metron" && sources[field] !== "gcd") continue;
    writable[field] = null;
    delete sources[field];
  }
  data.fieldSources = sources;
  await prisma.comic.update({ where: { id: comicId }, data });
  await writeLog({
    level: "info",
    source: "covers/backfill",
    message: `Cleared the automatic catalog link on ${comic.series} #${comic.issueNo || comic.issue || "?"} for a new match.`,
    details: { comicId },
  });
  revalidatePath("/covers");
  revalidatePath(`/issues/${comicId}`);
  return { ok: true, message: "Cleared the automatic link. Run cover backfill to match it again." };
}
