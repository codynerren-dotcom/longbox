import type { Comic } from "@prisma/client";
import { barcodeLookupKeys, parseComicBarcode, type ParsedBarcode } from "@/lib/barcode";
import type { CatalogMatch } from "@/lib/catalog/types";
import { gcdByBarcode, gcdSearch } from "@/lib/catalog/gcd";
import { metronByBarcode, metronConfigured, metronSearch } from "@/lib/catalog/metron";
import { prisma } from "@/lib/db";
import { safeImageUrl } from "@/lib/url";

export async function findByBarcode(parsed: ParsedBarcode): Promise<Comic | null> {
  const keys = barcodeLookupKeys(parsed);
  const exact = await prisma.comic.findFirst({ where: { barcode: { in: keys } } });
  if (exact) return exact;
  if (parsed.upc && parsed.upc.length >= 12) {
    return prisma.comic.findFirst({ where: { barcode: { startsWith: parsed.upc } } });
  }
  return null;
}

export function comicToMatch(comic: Comic): CatalogMatch {
  return {
    source: "local",
    externalId: comic.id,
    series: comic.series,
    issueNo: comic.issueNo ?? comic.issue ?? "",
    title: comic.fullTitle ?? comic.title ?? comic.series,
    publisher: comic.publisher,
    coverUrl: safeImageUrl(comic.coverUrl),
    coverDate: comic.coverDate,
    barcode: comic.barcode,
    plot: comic.plot,
    variant: comic.variant,
    coreSeriesId: comic.coreSeriesId,
    ownedId: comic.id,
  };
}

function dedupeMatches(matches: CatalogMatch[]): CatalogMatch[] {
  const seen = new Set<string>();
  const unique: CatalogMatch[] = [];
  for (const match of matches) {
    const key = `${match.source}:${match.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(match);
  }
  return unique;
}

export async function lookupBarcode(raw: string): Promise<{
  parsed: ParsedBarcode | null;
  owned: Comic | null;
  matches: CatalogMatch[];
  warnings: string[];
  metron: boolean;
}> {
  const parsed = parseComicBarcode(raw);
  const warnings: string[] = [];
  if (!parsed) {
    return { parsed: null, owned: null, matches: [], warnings: ["That barcode is not a UPC-A or UPC-A plus add-on."], metron: metronConfigured() };
  }

  const owned = await findByBarcode(parsed);
  if (owned) {
    return { parsed, owned, matches: [comicToMatch(owned)], warnings, metron: metronConfigured() };
  }

  const matches: CatalogMatch[] = [];
  if (metronConfigured()) {
    try {
      matches.push(...(await metronByBarcode(parsed)));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Metron lookup failed.");
    }
  } else {
    warnings.push("Metron credentials are not set, so that catalog was skipped.");
  }

  try {
    matches.push(...(await gcdByBarcode(parsed)));
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "GCD lookup failed.");
  }

  return {
    parsed,
    owned: null,
    matches: dedupeMatches(matches).slice(0, 3),
    warnings,
    metron: metronConfigured(),
  };
}

export async function searchCatalog(query: string, issueNo?: string): Promise<{
  matches: CatalogMatch[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const q = query.trim();
  if (!q) return { matches: [], warnings: ["Enter a series name."] };

  const local = await prisma.comic.findMany({
    where: {
      AND: [
        {
          OR: [
            { series: { contains: q, mode: "insensitive" } },
            { title: { contains: q, mode: "insensitive" } },
            { fullTitle: { contains: q, mode: "insensitive" } },
            { barcode: { contains: q } },
          ],
        },
        issueNo?.trim() ? { issueNo: issueNo.trim() } : {},
      ],
    },
    orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
    take: 3,
  });

  const matches: CatalogMatch[] = local.map(comicToMatch);
  if (matches.length >= 3) return { matches, warnings };

  if (metronConfigured()) {
    try {
      matches.push(...(await metronSearch(q, issueNo)));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Metron search failed.");
    }
  }

  if (matches.length < 3) {
    try {
      matches.push(...(await gcdSearch(q, issueNo)));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "GCD search failed.");
    }
  }

  return { matches: dedupeMatches(matches).slice(0, 3), warnings };
}
