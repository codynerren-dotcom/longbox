"use server";

import { revalidatePath } from "next/cache";
import { addWishlistItems, removeWishlistItem } from "@/lib/mutations";

export async function addMissingAction(formData: FormData) {
  const series = String(formData.get("series") ?? "").trim();
  const publisher = String(formData.get("publisher") ?? "");
  const seriesId = String(formData.get("seriesId") ?? "");
  const issues = String(formData.get("issues") ?? "")
    .split(",")
    .map((issue) => issue.trim())
    .filter(Boolean);
  if (series && issues.length > 0) {
    await addWishlistItems(issues.map((issueNo) => ({ series, publisher, issueNo })));
  }
  revalidatePath("/wishlist");
  if (seriesId) revalidatePath(`/series/${seriesId}`);
}

export async function removeWishlistAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (id) await removeWishlistItem(id);
  revalidatePath("/wishlist");
}
