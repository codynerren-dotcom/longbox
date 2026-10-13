"use server";

import { revalidatePath } from "next/cache";
import { attachMetronCover, queueCoverRetry, startCoverBackfillInBackground } from "@/lib/covers/run";

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
  return { status: "started", message: "Backfill started. Refresh to see new covers and anything Metron could not match." };
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
