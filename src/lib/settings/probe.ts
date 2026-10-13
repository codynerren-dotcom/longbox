import type { IntegrationConfig } from "@/lib/settings/resolve";

export type ProbeResult = { ok: boolean; message: string };

const TIMEOUT_MS = 8000;

export async function probeMetron(config: IntegrationConfig, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const basic = Boolean(config.metron.username && config.metron.password);
  const header = basic
    ? `Basic ${Buffer.from(`${config.metron.username}:${config.metron.password}`).toString("base64")}`
    : config.metron.token
      ? `Bearer ${config.metron.token}`
      : null;
  if (!header) return { ok: false, message: "Metron username and password are not set." };
  try {
    const response = await fetchImpl(`${config.metron.baseUrl}/series/?name=Saga`, {
      headers: { Accept: "application/json", Authorization: header, "User-Agent": "longbox/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) {
      return { ok: true, message: basic ? "Metron accepted the username and password." : "Metron accepted the API token." };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: basic ? "Metron rejected the username or password." : "Metron rejected the API token." };
    }
    return { ok: false, message: `Metron returned ${response.status}.` };
  } catch {
    return { ok: false, message: "Metron could not be reached." };
  }
}

export async function probeComicVine(config: IntegrationConfig, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  if (!config.comicvine.apiKey) return { ok: false, message: "Comic Vine API key is not set." };
  const url = new URL("https://comicvine.gamespot.com/api/issues/");
  url.searchParams.set("api_key", config.comicvine.apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("field_list", "id");
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "longbox/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, message: "Comic Vine rejected the API key." };
    if (!response.ok) return { ok: false, message: `Comic Vine returned ${response.status}.` };
    const body = (await response.json()) as { status_code?: number };
    if (body.status_code === 1) return { ok: true, message: "Comic Vine accepted the API key." };
    if (body.status_code === 100) return { ok: false, message: "Comic Vine rejected the API key." };
    return { ok: false, message: "Comic Vine did not accept the API key." };
  } catch {
    return { ok: false, message: "Comic Vine could not be reached." };
  }
}

export async function probeEbay(config: IntegrationConfig, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  if (!config.ebay.clientId || !config.ebay.clientSecret) return { ok: false, message: "eBay client id and secret are not set." };
  const header = `Basic ${Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64")}`;
  try {
    const response = await fetchImpl("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: header,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "longbox/1.0",
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, message: "eBay accepted the client id and secret." };
    if (response.status === 401 || response.status === 403) return { ok: false, message: "eBay rejected the client id or secret." };
    return { ok: false, message: `eBay returned ${response.status}.` };
  } catch {
    return { ok: false, message: "eBay could not be reached." };
  }
}
