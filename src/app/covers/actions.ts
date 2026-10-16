"use server";

import { revalidatePath } from "next/cache";
import { limitBlockFromError, limitNotices } from "@/lib/catalog/limit-notice";
import { hintFromBlocks, type QueueHint, type QueueSeed } from "@/lib/catalog/search-queue";
import { pausedLimitNotice } from "@/lib/catalog/limit-status";
import { unlinkIssueCatalog } from "@/lib/catalog/link-issue";
import { rematchAllSuspectCopies, rematchShelfCopy } from "@/lib/covers/facsimile-rematch";
import { sharedMetronLimiter } from "@/lib/covers/metron-client";
import { attachMetronCover, queueCoverRetry, startCoverBackfillInBackground } from "@/lib/covers/run";
import { prisma } from "@/lib/db";

export type BackfillActionState = {
  status: "idle" | "started" | "busy" | "error";
  message: string;
  notice: string;
};

export async function startCoverBackfillAction(): Promise<BackfillActionState> {
  const notice = (await pausedLimitNotice(["Metron", "GCD"])) ?? "";
  const result = await startCoverBackfillInBackground();
  revalidatePath("/covers");
  if (result === "unconfigured") {
    return { status: "error", message: "Add a Metron API token, or a username and password, in Settings, then start the backfill again.", notice };
  }
  if (result === "busy") {
    return { status: "busy", message: "A cover backfill is already running. Refresh in a moment.", notice };
  }
  return { status: "started", message: "Backfill started. Progress stays on this page while you move around the shelf.", notice };
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
  if (!id) return { status: "error", id, message: "Missing issue.", notice: "" };
  try {
    await attachMetronCover(id, metronIssueId);
    revalidatePath("/covers");
    revalidatePath("/", "layout");
    return { status: "ok", id, message: `Saved Metron ${metronIssueId}.`, notice: "" };
  } catch (error) {
    const block = limitBlockFromError(error, sharedMetronLimiter().snapshot());
    const notice = block ? limitNotices([block], []) : "";
    return { status: "error", id, message: notice || (error instanceof Error ? error.message : "Could not save that Metron issue."), notice };
  }
}

export type AttachState = { status: "idle" | "ok" | "error"; id: string; message: string; notice: string };

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

export async function rematchSuspectAction(comicId: string): Promise<{ ok: boolean; message: string; notice: string | null; queue: QueueHint | null }> {
  try {
    const result = await rematchShelfCopy(comicId);
    revalidatePath("/covers");
    revalidatePath(`/issues/${comicId}`);
    revalidatePath("/", "layout");
    const queue =
      result.notice && result.outcome !== "matched" && result.outcome !== "skipped"
        ? hintFromBlocks("metron", result.limitBlocks, "relink")
        : null;
    return { ok: result.ok, message: result.message, notice: result.notice, queue };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not re-match that issue.";
    return { ok: false, message, notice: null, queue: null };
  }
}

export async function rematchAllSuspectsAction(): Promise<{ ok: boolean; message: string; notice: string | null; queueItems: QueueSeed[] }> {
  try {
    const result = await rematchAllSuspectCopies();
    revalidatePath("/covers");
    revalidatePath("/", "layout");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not re-match suspect links.";
    return { ok: false, message, notice: null, queueItems: [] };
  }
}
