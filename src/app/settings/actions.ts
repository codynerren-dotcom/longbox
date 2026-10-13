"use server";

import { revalidatePath } from "next/cache";
import { testComicVineConnection } from "@/lib/catalog/comicvine";
import { testMetronConnection } from "@/lib/catalog/metron";
import { testEbayFromSettings } from "@/lib/pricing/ebay";
import { clearSecret, saveSecret, setSeedOnEmpty } from "@/lib/settings/service";
import { isSecretKey, type SecretKey } from "@/lib/settings/resolve";
import type { ProbeResult } from "@/lib/settings/probe";

export type SettingsActionState = { status: "idle" | "ok" | "error"; message: string };

export async function saveSettingsAction(_prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  try {
    const keys: SecretKey[] = ["metron.username", "metron.password", "comicvine.apiKey", "ebay.clientId", "ebay.clientSecret"];
    for (const key of keys) {
      const value = String(formData.get(key) ?? "");
      if (value.trim()) await saveSecret(key, value);
    }
    await setSeedOnEmpty(formData.get("seedOnEmpty") === "on");
    revalidatePath("/settings");
    return { status: "ok", message: "Settings saved. Saved secrets stay on the server." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Settings could not be saved." };
  }
}

export async function clearSettingAction(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  if (!isSecretKey(key)) return;
  await clearSecret(key);
  revalidatePath("/settings");
}

export type ProbeActionState = ProbeResult & { service: string; status: "idle" | "done" };

export async function testConnectionAction(_prev: ProbeActionState, formData: FormData): Promise<ProbeActionState> {
  const service = String(formData.get("service") ?? "");
  const result =
    service === "metron"
      ? await testMetronConnection()
      : service === "comicvine"
        ? await testComicVineConnection()
        : service === "ebay"
          ? await testEbayFromSettings()
          : { ok: false, message: "Unknown service." };
  return { ...result, service, status: "done" };
}
