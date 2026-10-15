import { GcdBudgetError, rememberGcdPause, reserveGcdRequest } from "@/lib/catalog/gcd";
import { pauseComicVineUntil, reserveComicVineRequest } from "@/lib/catalog/match-search";
import { noteEbayPause, reserveEbayRequest } from "@/lib/catalog/rate-gate";
import { pauseLabel } from "@/lib/catalog/rate-limit";
import { retryAfterFromMessage, retryAfterMs } from "@/lib/covers/limiter";
import { assertMetronCircuit, isMetronTransportFailure, recordMetronTransportFailure, recordMetronTransportSuccess } from "@/lib/covers/metron-circuit";
import { sharedMetronLimiter } from "@/lib/covers/metron-client";
import { MetronBudgetError } from "@/lib/covers/types";
import { recordFetch } from "@/lib/log/api";
import type { LogSource } from "@/lib/log/types";
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
    assertMetronCircuit(Date.now());
    await sharedMetronLimiter().acquire("interactive");
  } catch (error) {
    if (error instanceof MetronBudgetError) return { ok: false, message: error.message };
    throw error;
  }
  const url = `${config.metron.baseUrl}/series/?name=Saga`;
  try {
    const response = await loggedFetch(fetchImpl, "metron", url, {
      headers: { Accept: "application/json", Authorization: header, "User-Agent": "longbox/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    sharedMetronLimiter().observe(response.headers);
    recordMetronTransportSuccess(Date.now());
    if (response.status === 429) {
      const body = await response.text().catch(() => "");
      const delay = retryAfterMs(response.headers, Date.now()) ?? retryAfterFromMessage(body) ?? 60_000;
      const resumeAt = Date.now() + delay;
      sharedMetronLimiter().notePause(resumeAt);
      return { ok: false, message: pauseLabel("Metron", resumeAt) };
    }
    if (response.ok) {
      return { ok: true, message: basic ? "Metron accepted the username and password." : "Metron accepted the API token." };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: basic ? "Metron rejected the username or password." : "Metron rejected the API token." };
    }
    return { ok: false, message: `Metron returned ${response.status}.` };
  } catch (error) {
    if (!(error instanceof MetronBudgetError) && isMetronTransportFailure(error)) {
      try {
        await recordMetronTransportFailure(error, Date.now());
      } catch (paused) {
        if (paused instanceof MetronBudgetError) return { ok: false, message: paused.message };
      }
    }
    if (error instanceof MetronBudgetError) return { ok: false, message: error.message };
    return { ok: false, message: "Metron could not be reached." };
  }
}

export async function probeComicVine(config: IntegrationConfig, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  if (!config.comicvine.apiKey) return { ok: false, message: "Comic Vine API key is not set." };
  try {
    await reserveComicVineRequest("/issues/");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Comic Vine is paused." };
  }
  const url = new URL("https://comicvine.gamespot.com/api/issues/");
  url.searchParams.set("api_key", config.comicvine.apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("field_list", "id");
  try {
    const response = await loggedFetch(fetchImpl, "comicvine", url, {
      headers: { Accept: "application/json", "User-Agent": "longbox/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 420 || response.status === 429) {
      const resumeAt = Date.now() + 60 * 60 * 1000;
      await pauseComicVineUntil(resumeAt);
      return { ok: false, message: pauseLabel("Comic Vine", resumeAt) };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, message: "Comic Vine rejected the API key." };
    if (!response.ok) return { ok: false, message: `Comic Vine returned ${response.status}.` };
    const body = (await response.json()) as { status_code?: number };
    if (body.status_code === 107) {
      const resumeAt = Date.now() + 60 * 60 * 1000;
      await pauseComicVineUntil(resumeAt);
      return { ok: false, message: pauseLabel("Comic Vine", resumeAt) };
    }
    if (body.status_code === 1) return { ok: true, message: "Comic Vine accepted the API key." };
    if (body.status_code === 100) return { ok: false, message: "Comic Vine rejected the API key." };
    return { ok: false, message: "Comic Vine did not accept the API key." };
  } catch {
    return { ok: false, message: "Comic Vine could not be reached." };
  }
}

export async function probeGcd(config: IntegrationConfig, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    await reserveGcdRequest();
  } catch (error) {
    if (error instanceof GcdBudgetError) return { ok: false, message: error.message };
    throw error;
  }
  const base = (process.env.GCD_API_BASE || "https://www.comics.org").replace(/\/$/, "");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "longbox/1.0 (personal comic shelf)",
  };
  const authed = Boolean(config.gcd.username && config.gcd.password);
  if (authed) headers.Authorization = `Basic ${Buffer.from(`${config.gcd.username}:${config.gcd.password}`).toString("base64")}`;
  try {
    const response = await loggedFetch(fetchImpl, "gcd", `${base}/api/series/name/Saga/`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429) {
      const body = await response.text().catch(() => "");
      const delay = retryAfterMs(response.headers, Date.now()) ?? retryAfterFromMessage(body) ?? 60_000;
      const resumeAt = Date.now() + delay;
      await rememberGcdPause(resumeAt);
      return { ok: false, message: pauseLabel("GCD", resumeAt) };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, message: "GCD rejected the username or password." };
    if (!response.ok) return { ok: false, message: `GCD returned ${response.status}.` };
    return { ok: true, message: authed ? "GCD accepted the username and password." : "GCD answered." };
  } catch {
    return { ok: false, message: "GCD could not be reached." };
  }
}

export async function probeEbay(config: IntegrationConfig, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  if (!config.ebay.clientId || !config.ebay.clientSecret) return { ok: false, message: "eBay client id and secret are not set." };
  const header = `Basic ${Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64")}`;
  try {
    await reserveEbayRequest();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "eBay is paused." };
  }
  try {
    const response = await loggedFetch(fetchImpl, "ebay/pricing", "https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: header,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "longbox/1.0",
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429) {
      const body = await response.text().catch(() => "");
      const delay = retryAfterMs(response.headers, Date.now()) ?? retryAfterFromMessage(body) ?? 60_000;
      const resumeAt = Date.now() + delay;
      await noteEbayPause(resumeAt);
      return { ok: false, message: pauseLabel("eBay", resumeAt) };
    }
    if (response.ok) return { ok: true, message: "eBay accepted the client id and secret." };
    if (response.status === 401 || response.status === 403) return { ok: false, message: "eBay rejected the client id or secret." };
    return { ok: false, message: `eBay returned ${response.status}.` };
  } catch {
    return { ok: false, message: "eBay could not be reached." };
  }
}

async function loggedFetch(fetchImpl: typeof fetch, source: LogSource, url: string | URL, init: RequestInit): Promise<Response> {
  const started = Date.now();
  const target = typeof url === "string" ? url : url.toString();
  try {
    const response = await fetchImpl(url, init);
    await recordFetch({ source, method: init.method, url: target, startedAt: started, status: response.status });
    return response;
  } catch (error) {
    await recordFetch({
      source,
      method: init.method,
      url: target,
      startedAt: started,
      status: null,
      error: error instanceof Error ? error.message : "Request failed.",
    });
    throw error;
  }
}
