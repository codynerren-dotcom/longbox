"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { addComics } from "@/lib/mutations";

export type AddIssueState = {
  status: "idle" | "added" | "exists" | "error";
  message: string;
};

export async function addSeriesIssueAction(_previous: AddIssueState, formData: FormData): Promise<AddIssueState> {
  const series = String(formData.get("series") ?? "").trim();
  const issueNo = String(formData.get("issueNo") ?? "").trim();
  const publisher = String(formData.get("publisher") ?? "").trim();
  const seriesId = String(formData.get("seriesId") ?? "").trim();
  const coreSeriesId = String(formData.get("coreSeriesId") ?? "").trim();
  const variantRaw = String(formData.get("variant") ?? "").trim();
  const variant = /^[A-Za-z]$/.test(variantRaw) ? variantRaw.toUpperCase() : variantRaw;
  const variantDescription = String(formData.get("variantDescription") ?? "").trim();

  if (!series || !issueNo) {
    return { status: "error", message: "Enter an issue number." };
  }

  const viewer = await getViewer();
  const results = await addComics(
    [
      {
        series,
        issueNo,
        publisher: publisher || null,
        variant: variant || null,
        variantDescription: variantDescription || null,
        source: "manual",
        coreSeriesId: coreSeriesId || null,
      },
    ],
    viewer.email,
  );
  const added = results[0];
  revalidatePath("/collection");
  revalidatePath("/series");
  revalidatePath("/");
  if (seriesId) revalidatePath(`/series/${seriesId}`);

  if (!added) return { status: "error", message: "Enter an issue number." };
  if (!added.created) return { status: "exists", message: "That copy is already on the shelf." };
  const letter = /^[A-Za-z]$/.test(variant) ? variant.toUpperCase() : "";
  return { status: "added", message: `Added #${issueNo}${letter}.` };
}
