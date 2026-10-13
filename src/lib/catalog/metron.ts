import type { CatalogMatch } from "@/lib/catalog/types";
import type { ParsedBarcode } from "@/lib/barcode";
import { safeImageUrl } from "@/lib/url";

type MetronIssue = {
  id?: number | string;
  number?: string;
  issue?: string;
  image?: string | null;
  cover_date?: string | null;
  desc?: string | null;
  upc?: string | null;
  series?: {
    id?: number | string;
    name?: string;
    publisher?: { name?: string } | string | null;
  } | null;
  publisher?: { name?: string } | string | null;
};

type MetronPage = {
  results?: MetronIssue[];
};

export function metronConfigured(): boolean {
  return Boolean(process.env.METRON_API_TOKEN || (process.env.METRON_USERNAME && process.env.METRON_PASSWORD));
}

function metronBase(): string {
  return (process.env.METRON_API_BASE || "https://metron.cloud/api").replace(/\/$/, "");
}

function authHeader(): string {
  const token = process.env.METRON_API_TOKEN;
  if (token) return `Bearer ${token}`;
  const username = process.env.METRON_USERNAME ?? "";
  const password = process.env.METRON_PASSWORD ?? "";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function metronGet(pathAndQuery: string): Promise<MetronPage> {
  const response = await fetch(`${metronBase()}${pathAndQuery}`, {
    headers: {
      Accept: "application/json",
      Authorization: authHeader(),
      "User-Agent": "longbox/1.0",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Metron returned ${response.status}`);
  }
  return (await response.json()) as MetronPage;
}

function publisherName(issue: MetronIssue): string | null {
  const direct = issue.publisher;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && direct.name) return direct.name;
  const nested = issue.series?.publisher;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object" && nested.name) return nested.name;
  return null;
}

function toMatch(issue: MetronIssue, barcode: string | null): CatalogMatch | null {
  const series = issue.series?.name?.trim();
  if (!series || issue.id == null) return null;
  const issueNo = issue.number?.trim() || "";
  return {
    source: "metron",
    externalId: String(issue.id),
    series,
    issueNo,
    title: issue.issue?.trim() || (issueNo ? `${series} #${issueNo}` : series),
    publisher: publisherName(issue),
    coverUrl: safeImageUrl(issue.image),
    coverDate: issue.cover_date ?? null,
    barcode: issue.upc ?? barcode,
    plot: issue.desc ?? null,
    variant: null,
    coreSeriesId: issue.series?.id != null ? `metron-${issue.series.id}` : null,
    ownedId: null,
  };
}

export async function metronByBarcode(parsed: ParsedBarcode): Promise<CatalogMatch[]> {
  if (!metronConfigured()) return [];
  const queries = [`/issue/?upc=${encodeURIComponent(parsed.combined)}`];
  if (parsed.upc && parsed.upc !== parsed.combined) {
    queries.push(`/issue/?upc_starts_with=${encodeURIComponent(parsed.upc)}`);
  }
  const matches: CatalogMatch[] = [];
  for (const query of queries) {
    const page = await metronGet(query);
    for (const issue of page.results ?? []) {
      const match = toMatch(issue, parsed.combined);
      if (match) matches.push(match);
    }
    if (matches.length > 0) break;
  }
  return matches;
}

export async function metronSearch(query: string, issueNo?: string): Promise<CatalogMatch[]> {
  if (!metronConfigured() || !query.trim()) return [];
  const params = new URLSearchParams({ series_name: query.trim() });
  if (issueNo?.trim()) params.set("number", issueNo.trim());
  const page = await metronGet(`/issue/?${params.toString()}`);
  return (page.results ?? [])
    .map((issue) => toMatch(issue, null))
    .filter((match): match is CatalogMatch => match !== null);
}
