import type { CatalogMatch } from "@/lib/catalog/types";
import type { ParsedBarcode } from "@/lib/barcode";
import { recordFetch } from "@/lib/log/api";
import { safeImageUrl } from "@/lib/url";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as UnknownRecord;
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["results", "issues", "data", "items"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function nameOf(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return text(record.name) ?? text(record.title) ?? text(record.series_name);
}

function toMatch(value: unknown, barcode: string): CatalogMatch | null {
  const record = asRecord(value);
  if (!record) return null;
  const seriesRecord = asRecord(record.series);
  const series = nameOf(record.series) ?? text(record.series_name);
  if (!series) return null;
  const issueNo = text(record.number) ?? text(record.issue_number) ?? text(record.issue) ?? "";
  const id = text(record.id) ?? text(record.issue_id) ?? `${series}-${issueNo}`;
  const seriesId = text(seriesRecord?.id) ?? text(record.series_id);
  return {
    source: "gcd",
    externalId: id,
    series,
    issueNo,
    title: text(record.title) ?? (issueNo ? `${series} #${issueNo}` : series),
    publisher: nameOf(record.publisher) ?? nameOf(seriesRecord?.publisher) ?? text(record.publisher_name),
    coverUrl: safeImageUrl(text(record.cover_url) ?? text(record.image) ?? text(record.cover)),
    coverDate: text(record.publication_date) ?? text(record.cover_date),
    barcode: text(record.barcode) ?? barcode,
    plot: text(record.notes) ?? text(record.synopsis),
    variant: text(record.variant_name) ?? text(record.variant),
    coreSeriesId: seriesId ? `gcd-${seriesId}` : null,
    ownedId: null,
  };
}

function gcdBase(): string {
  return (process.env.GCD_API_BASE || "https://www.comics.org").replace(/\/$/, "");
}

async function gcdGet(pathAndQuery: string): Promise<unknown> {
  const url = `${gcdBase()}${pathAndQuery}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "longbox/1.0 (personal comic shelf)",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    await recordFetch({
      source: "system",
      url,
      startedAt: started,
      status: null,
      error: error instanceof Error ? error.message : "Request failed.",
    });
    throw error;
  }
  await recordFetch({ source: "system", url, startedAt: started, status: response.status });
  if (!response.ok) throw new Error(`GCD returned ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("javascript")) {
    throw new Error("GCD response was not JSON");
  }
  return response.json();
}

/** Try the public issue endpoints that accept a barcode filter. Skip quietly on failure. */
export async function gcdByBarcode(parsed: ParsedBarcode): Promise<CatalogMatch[]> {
  const code = encodeURIComponent(parsed.combined);
  const paths = [`/api/v2/issues/?barcode=${code}`, `/api/issues/?barcode=${code}`];
  if (parsed.upc && parsed.upc !== parsed.combined) {
    const upc = encodeURIComponent(parsed.upc);
    paths.push(`/api/v2/issues/?barcode=${upc}`, `/api/issues/?barcode=${upc}`);
  }
  for (const path of paths) {
    try {
      const body = await gcdGet(path);
      const matches = asArray(body)
        .map((item) => toMatch(item, parsed.combined))
        .filter((match): match is CatalogMatch => match !== null);
      if (matches.length > 0) return matches;
    } catch {
      continue;
    }
  }
  return [];
}

export async function gcdSearch(query: string, issueNo?: string): Promise<CatalogMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const seriesPath = `/api/series/name/${encodeURIComponent(trimmed)}/`;
  try {
    const body = await gcdGet(seriesPath);
    const seriesList = asArray(body);
    const first = asRecord(seriesList[0] ?? body);
    const seriesId = text(first?.id);
    if (!seriesId) return [];
    const issueBody = await gcdGet(`/api/series/${seriesId}/issues/`);
    return asArray(issueBody)
      .map((item) => toMatch(item, ""))
      .filter((match): match is CatalogMatch => match !== null)
      .filter((match) => (issueNo?.trim() ? match.issueNo === issueNo.trim() : true));
  } catch {
    return [];
  }
}
