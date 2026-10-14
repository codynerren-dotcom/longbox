"use server";

import { revalidatePath } from "next/cache";
import { probeComicVine, probeEbay, probeMetron, type ProbeResult } from "@/lib/settings/probe";
import { applyCredentialOverrides, isSecretKey, SECRET_KEYS, type SecretKey } from "@/lib/settings/resolve";
import { clearSecret, getSettings, saveSecret, setSeedOnEmpty } from "@/lib/settings/service";

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

export async function saveServiceAction(_prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  try {
    let wrote = 0;
    for (const key of SECRET_KEYS) {
      const value = String(formData.get(key) ?? "");
      if (!value.trim()) continue;
      await saveSecret(key, value);
      wrote += 1;
    }
    revalidatePath("/settings");
    return wrote > 0 ? { status: "ok", message: "Saved." } : { status: "ok", message: "Already saved." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Settings could not be saved." };
  }
}

export async function testConnectionAction(_prev: ProbeActionState, formData: FormData): Promise<ProbeActionState> {
  const service = String(formData.get("service") ?? "");
  const config = applyCredentialOverrides(await getSettings(), typedSecrets(formData));
  const result =
    service === "metron"
      ? await probeMetron(config)
      : service === "comicvine"
        ? await probeComicVine(config)
        : service === "ebay"
          ? await probeEbay(config)
          : { ok: false, message: "Unknown service." };
  return { ...result, service, status: "done" };
}

function typedSecrets(formData: FormData): Partial<Record<SecretKey, string>> {
  const fields: Partial<Record<SecretKey, string>> = {};
  for (const key of SECRET_KEYS) {
    const value = formData.get(key);
    if (typeof value === "string" && value.trim()) fields[key] = value.trim();
  }
  return fields;
}
