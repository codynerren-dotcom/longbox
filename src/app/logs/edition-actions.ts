"use server";

import { revalidatePath } from "next/cache";
import { clearEditionRematch, resumeEditionRematch } from "@/lib/covers/facsimile-rematch";

function refresh(): void {
  revalidatePath("/logs");
  revalidatePath("/review");
  revalidatePath("/covers");
}

export async function resumeEditionJobAction(): Promise<{ ok: boolean; message: string }> {
  const result = await resumeEditionRematch();
  refresh();
  return result;
}

export async function clearEditionJobAction(): Promise<{ ok: boolean; message: string }> {
  const result = await clearEditionRematch();
  refresh();
  return result;
}
