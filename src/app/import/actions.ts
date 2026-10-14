"use server";

import { revalidatePath } from "next/cache";
import { parseClzCsv, ClzParseError } from "@/lib/clz/parse";
import { persistClzComics, type ImportSummary } from "@/lib/clz/persist";
import { recordImportRun } from "@/lib/imports";

export type ImportActionState =
  | { status: "idle" }
  | { status: "ok"; summary: ImportSummary; warnings: string[] }
  | { status: "error"; error: string };

export async function importClzAction(_prev: ImportActionState, formData: FormData): Promise<ImportActionState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", error: "Choose a CLZ CSV export." };
  }
  try {
    const text = await file.text();
    const parsed = parseClzCsv(text);
    const summary = await persistClzComics(parsed.comics);
    await recordImportRun({ filename: file.name || "export.csv", source: "upload", summary });
    revalidatePath("/", "layout");
    return { status: "ok", summary, warnings: parsed.warnings };
  } catch (error) {
    const message = error instanceof ClzParseError || error instanceof Error ? error.message : "Import failed.";
    return { status: "error", error: message };
  }
}
