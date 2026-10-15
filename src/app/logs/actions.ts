"use server";

import { revalidatePath } from "next/cache";
import { clearLogs } from "@/lib/log/write";

export type ClearLogsState = { status: "idle" | "ok" | "error"; message: string };

export async function clearLogsAction(_prev: ClearLogsState, formData: FormData): Promise<ClearLogsState> {
  if (formData.get("confirm") !== "yes") {
    return { status: "error", message: "Confirm before clearing logs." };
  }
  try {
    await clearLogs();
    revalidatePath("/logs");
    return { status: "ok", message: "Logs cleared." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Logs could not be cleared." };
  }
}
