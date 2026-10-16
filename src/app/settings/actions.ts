"use server";

import { revalidatePath } from "next/cache";
import { logConnectionTest, logSettingsChange } from "@/lib/log/events";
import { probeComicVine, probeEbay, probeGcd, probeMetron, type ProbeResult } from "@/lib/settings/probe";
import { applyCredentialOverrides, CREDENTIAL_KEYS, isCredentialKey, isPlainKey, type CredentialKey } from "@/lib/settings/resolve";
import { clearSecret, getSettings, savePlain, saveSecret, setSeedOnEmpty } from "@/lib/settings/service";

export type SettingsActionState = { status: "idle" | "ok" | "error"; message: string };

export async function saveSettingsAction(_prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  try {
    const keys: string[] = [];
    for (const key of CREDENTIAL_KEYS) {
      const value = String(formData.get(key) ?? "");
      if (value.trim()) {
        await saveCredential(key, value);
        keys.push(key);
      }
    }
    await setSeedOnEmpty(formData.get("seedOnEmpty") === "on");
    keys.push("seedOnEmpty");
    await logSettingsChange(keys);
    revalidatePath("/settings");
    return { status: "ok", message: "Settings saved. Saved secrets stay on the server." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Settings could not be saved." };
  }
}

export async function clearSettingAction(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  if (!isCredentialKey(key)) return;
  await clearSecret(key);
  await logSettingsChange([key], "Cleared");
  revalidatePath("/settings");
}

export type ProbeActionState = ProbeResult & { service: string; status: "idle" | "done" };

export async function saveServiceAction(_prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  try {
    const keys: string[] = [];
    for (const key of CREDENTIAL_KEYS) {
      const value = String(formData.get(key) ?? "");
      if (!value.trim()) continue;
      await saveCredential(key, value);
      keys.push(key);
    }
    await logSettingsChange(keys);
    revalidatePath("/settings");
    return keys.length > 0 ? { status: "ok", message: "Saved." } : { status: "ok", message: "Already saved." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Settings could not be saved." };
  }
}

export async function testGcdLoginAction(_prev: ProbeActionState): Promise<ProbeActionState> {
  const config = await getSettings();
  if (!config.gcd.username || !config.gcd.password) {
    const result = { ok: false, message: "Save a GCD username and password, then test the login." };
    await logConnectionTest("gcd", result);
    return { ...result, service: "gcd", status: "done" };
  }
  const result = await probeGcd(config);
  const shown = result.ok
    ? { ...result, message: "Signed in. GCD accepted the username and password. The limit is 2,000 per day." }
    : result;
  await logConnectionTest("gcd", shown);
  return { ...shown, service: "gcd", status: "done" };
}

export async function testConnectionAction(_prev: ProbeActionState, formData: FormData): Promise<ProbeActionState> {
  const service = String(formData.get("service") ?? "");
  const config = applyCredentialOverrides(await getSettings(), typedSecrets(formData));
  const result =
    service === "metron"
      ? await probeMetron(config)
      : service === "gcd"
        ? await probeGcd(config)
        : service === "comicvine"
          ? await probeComicVine(config)
          : service === "ebay"
            ? await probeEbay(config)
            : { ok: false, message: "Unknown service." };
  await logConnectionTest(service || "unknown", result);
  return { ...result, service, status: "done" };
}

async function saveCredential(key: CredentialKey, value: string): Promise<void> {
  if (isPlainKey(key)) await savePlain(key, value);
  else await saveSecret(key, value);
}

function typedSecrets(formData: FormData): Partial<Record<CredentialKey, string>> {
  const fields: Partial<Record<CredentialKey, string>> = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = formData.get(key);
    if (typeof value === "string" && value.trim()) fields[key] = value.trim();
  }
  return fields;
}
