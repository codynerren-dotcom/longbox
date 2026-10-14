"use server";

import { revalidatePath } from "next/cache";
import { refreshIssueFromMetron } from "@/lib/covers/run";
import { setReadState } from "@/lib/mutations";

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
  if (result.ok) {
    revalidatePath(`/issues/${comicId}`);
    revalidatePath("/logs");
  }
  return result;
}
