"use server";

import { revalidatePath } from "next/cache";
import { formatPauseClock } from "@/lib/catalog/rate-limit";
import { cancelQueuedSearch, enqueueSearch } from "@/lib/catalog/search-queue-run";
import type { QueueRequest } from "@/lib/catalog/search-queue";

export async function queueSearchAction(input: QueueRequest | QueueRequest[]): Promise<{ ok: boolean; message: string }> {
  const items = Array.isArray(input) ? input : [input];
  if (items.length === 0) return { ok: false, message: "Nothing to queue." };
  let added = 0;
  let duplicate = 0;
  let firstAt: number | null = null;
  let last = "";
  for (const item of items) {
    const result = await enqueueSearch(item);
    if (!result.ok) return { ok: false, message: result.message };
    last = result.message;
    if (result.queued) added += 1;
    else duplicate += 1;
    firstAt = firstAt == null ? result.resumeAt : Math.min(firstAt, result.resumeAt);
  }
  revalidatePath("/logs");
  if (items.length === 1) return { ok: true, message: last };
  if (added === 0) return { ok: true, message: last };
  const clock = firstAt != null ? formatPauseClock(firstAt) : "";
  const extra = duplicate > 0 ? ` ${duplicate} already queued.` : "";
  return { ok: true, message: `Queued ${added}.${clock ? ` First runs at ${clock}.` : ""}${extra}` };
}

export async function cancelQueuedSearchAction(id: string): Promise<{ ok: boolean; message: string }> {
  const result = await cancelQueuedSearch(id);
  revalidatePath("/logs");
  return result;
}
