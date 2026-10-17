import { afterEach, describe, expect, it } from "vitest";
import { searchComicVineMatches, searchMetronMatches } from "@/lib/catalog/match-search";
import type { GcdCatalog, GcdIssueRow } from "@/lib/catalog/gcd";
import { matchQuery } from "@/lib/catalog/manual-link";
import { COLLECTED_METRON_MISS, setCollectedMissCacheForTests, type CollectedMissCache, type StoredCollectedMiss } from "@/lib/covers/collected-miss";
import { emptyBudget, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import type { MetronTransport } from "@/lib/covers/metron-client";
import { resolveCover } from "@/lib/covers/match";
import { resolveGcdCover } from "@/lib/covers/gcd-match";
import type { CoverLookup, CoverQuery, MetronIssueHit, MetronSeriesHit } from "@/lib/covers/types";
import { canonicalIsbn, catalogMatchIssue, volumeNumber } from "@/lib/shelf-format";

afterEach(() => {
  setCollectedMissCacheForTests(null);
});

function memoryCache(): CollectedMissCache & { size: number } {
  const store = new Map<string, StoredCollectedMiss>();
  return {
    get size() {
      return store.size;
    },
    async read(key) {
      return store.get(key) ?? null;
    },
    async write(key, row) {
      store.set(key, row);
    },
  };
}

function transport(fetchImpl: MetronTransport["fetch"]): MetronTransport {
  const budget: MetronBudget = emptyBudget();
  const store: BudgetStore = {
    read: () => budget,
    write: (next) => {
      budget.day = next.day;
      budget.count = next.count;
      budget.lastRequestAt = next.lastRequestAt;
    },
  };
  let time = 1_700_000_000_000;
  return {
    limiter: new MetronLimiter(store, () => time, async (ms) => {
      time += ms;
    }, () => "2026-10-17"),
    username: "reader",
    password: "secret",
    baseUrl: "https://metron.cloud/api",
    now: () => time,
    fetch: fetchImpl,
  };
}

function tradeIssue(id: string, seriesName: string, number = "1"): MetronIssueHit {
  return {
    id,
    seriesId: "15",
    seriesName,
    number,
    coverYear: 2021,
    imageUrl: "https://example.com/trade.jpg",
    label: null,
    publisher: "Image",
  };
}

function series(id: string, name: string, seriesType: string | null, issueCount = 1): MetronSeriesHit {
  return { id, name, yearBegan: 2017, yearEnd: null, publisher: "Image", seriesType, issueCount };
}

function lookup(calls: string[], typed: MetronSeriesHit[], issues: MetronIssueHit[] = []): CoverLookup {
  return {
    async issuesByUpc() {
      calls.push("upc");
      return [tradeIssue("1", "God Country")];
    },
    async issuesByUpcPrefix() {
      calls.push("upc-prefix");
      return [];
    },
    async issuesByIsbn(isbn) {
      calls.push(`isbn:${isbn}`);
      return [tradeIssue("1", "God Country")];
    },
    async searchSeries(name) {
      calls.push(`series:${name}`);
      return [series("6", "God Country", "Limited Series", 6)];
    },
    async searchSeriesByType(name, seriesType) {
      calls.push(`typed:${name}:${seriesType}`);
      return typed;
    },
    async issuesForSeries(seriesId, number) {
      calls.push(`issues:${seriesId}:${number}`);
      return issues;
    },
  };
}

function godCountry(overrides: Partial<CoverQuery> = {}): CoverQuery {
  return {
    series: "God Country",
    issueNo: "TP-A",
    issue: "TP-A",
    coverYear: 2018,
    barcode: "9781534302341",
    variant: null,
    publisher: "Image",
    format: "Comic",
    shelfFormat: "single",
    ...overrides,
  };
}

function truth(overrides: Partial<CoverQuery> = {}): CoverQuery {
  return {
    series: "The Department of Truth",
    issueNo: "TP",
    issue: "TP",
    coverYear: 2021,
    barcode: "9781534318331",
    variant: null,
    publisher: "Image",
    format: "Trade Paperback",
    shelfFormat: "tp",
    ...overrides,
  };
}

function gcdIssue(id: string, seriesId: string, seriesName: string, number: string, isbn: string | null): GcdIssueRow {
  return {
    id,
    seriesId,
    seriesName,
    number,
    variant: null,
    title: null,
    coverDate: "2018",
    coverYear: 2018,
    onSaleYear: 2018,
    onSaleDate: null,
    price: null,
    pageCount: null,
    barcode: isbn,
    isbn,
    publisher: "Image",
    writer: null,
    artist: null,
    coverArtist: null,
    characters: null,
    seriesYear: 2017,
    comicvineIssueId: null,
    metronIssueId: null,
  };
}

describe("collected trade queries", () => {
  it("normalizes TP and TP-A to volume 1", () => {
    expect(volumeNumber("TP")).toBe("1");
    expect(volumeNumber("TP-A")).toBe("1");
    expect(volumeNumber("TP-2")).toBe("2");
    expect(volumeNumber("HC")).toBe("1");
    expect(volumeNumber("Omnibus")).toBe("1");
    expect(catalogMatchIssue({ shelfFormat: "single", issueNo: "TP-A", issue: "TP-A" })).toEqual({ format: "tp", number: "1" });
    expect(catalogMatchIssue({ shelfFormat: "single", issueNo: "7", issue: "7" })).toEqual({ format: "single", number: "7" });
    expect(matchQuery({ series: "God Country", issueNo: "TP-A", year: 2017 })).toBe("God Country Vol. 1 2017");
    expect(matchQuery({ series: "The Department of Truth", issueNo: "TP", year: 2021 })).toBe("The Department of Truth Vol. 1 2021");
    expect(canonicalIsbn("9781534302341")).toBe("9781534302341");
    expect(canonicalIsbn("978-1-5343-0234-1")).toBe("9781534302341");
    expect(canonicalIsbn("0306406152")).toBe("9780306406157");
    expect(canonicalIsbn("75960608857700712")).toBeNull();
  });

  it("does not link God Country TP-A to the limited series, and remembers the miss", async () => {
    const cache = memoryCache();
    setCollectedMissCacheForTests(cache);
    const calls: string[] = [];
    const client = lookup(calls, [series("6", "God Country", "Limited Series", 6)], [tradeIssue("1", "God Country")]);
    const first = await resolveCover(godCountry(), client);
    expect(first).toMatchObject({ status: "unmatched", reason: COLLECTED_METRON_MISS });
    expect(calls.some((call) => call.startsWith("typed:God Country:Trade Paperback"))).toBe(true);
    expect(calls.some((call) => call.startsWith("issues:") || call.startsWith("isbn:") || call === "upc" || call.startsWith("series:"))).toBe(false);
    expect(cache.size).toBe(1);

    const before = calls.length;
    const second = await resolveCover(godCountry(), client);
    expect(second).toMatchObject({ status: "unmatched", reason: COLLECTED_METRON_MISS });
    expect(calls.length).toBe(before);
  });

  it("links Department of Truth TP to the trade series volume, not a floppy", async () => {
    const calls: string[] = [];
    const client = lookup(calls, [series("15", "The Department of Truth", "Trade Paperback")], [tradeIssue("40", "The Department of Truth")]);
    const decision = await resolveCover(truth(), client);
    expect(decision).toMatchObject({ status: "matched", issue: { id: "40" } });
    expect(calls).toContain("typed:The Department of Truth:Trade Paperback");
    expect(calls).toContain("issues:15:1");
    expect(calls.some((call) => call.startsWith("isbn:") || call === "upc" || call.startsWith("series:"))).toBe(false);
  });

  it("searches Metron by series name and series type only", async () => {
    const cache = memoryCache();
    setCollectedMissCacheForTests(cache);
    const paths: string[] = [];
    const client = transport(async (url) => {
      const path = String(url);
      paths.push(path);
      if (!path.includes("series_type=")) {
        return Response.json({
          results: [{ id: 6, name: "God Country", year_began: 2017, series_type: { name: "Limited Series" }, issue_count: 6 }],
        });
      }
      if (path.includes("/issue/")) {
        return Response.json({
          results: [{ id: 1, number: "1", series: { id: 6, name: "God Country", series_type: { name: "Limited Series" } } }],
        });
      }
      return Response.json({ results: [] });
    });
    const missed = await searchMetronMatches(client, "God Country TP-A", "9781534302341", "query", "single");
    expect(missed).toEqual([]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path).toContain("/series/?");
      expect(path).toContain("series_type=Trade+Paperback");
      expect(path).toContain("name=God+Country");
      expect(path).not.toContain("/issue/");
      expect(path).not.toContain("isbn=");
      expect(path).not.toContain("upc=");
      expect(path).not.toContain("gcd_id=");
    }
    const before = paths.length;
    await searchMetronMatches(client, "God Country TP-A", "9781534302341", "query", "single");
    expect(paths.length).toBe(before);

    const foundPaths: string[] = [];
    const found = await searchMetronMatches(
      transport(async (url) => {
        const path = String(url);
        foundPaths.push(path);
        if (path.includes("/series/")) {
          return Response.json({
            results: [{ id: 15, name: "The Department of Truth", year_began: 2020, series_type: { name: "Trade Paperback" } }],
          });
        }
        return Response.json({
          results: [{ id: 40, number: "1", series: { id: 15, name: "The Department of Truth", series_type: { name: "Trade Paperback" } }, image: "https://example.com/a.jpg" }],
        });
      }),
      "The Department of Truth TP",
      "",
      "query",
      "tp",
    );
    expect(found[0]?.id).toBe("40");
    expect(foundPaths[0]).toContain("series_type=Trade+Paperback");
    expect(foundPaths[0]).toContain("name=The+Department+of+Truth");
    expect(foundPaths[1]).toContain("series_id=15");
    expect(foundPaths[1]).toContain("number=1");
    expect(foundPaths.some((path) => path.includes("isbn=") || path.includes("upc=") || path.includes("gcd_id="))).toBe(false);
  });

  it("matches God Country and Department of Truth on GCD by ISBN, then name and volume", async () => {
    const godTrade = gcdIssue("20", "2", "God Country", "1", "9781534302341");
    const godSingle = gcdIssue("10", "1", "God Country", "1", null);
    const truthTrade = gcdIssue("30", "4", "The Department of Truth", "1", "9781534318331");
    const truthSingle = gcdIssue("31", "3", "The Department of Truth", "1", null);
    const asked: string[] = [];
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        asked.push(name);
        if (name === "God Country") {
          return [
            { id: "1", name: "God Country", yearBegan: 2017, yearEnded: 2017, format: "limited series", issues: [{ id: "10", descriptor: "1" }] },
            { id: "2", name: "God Country", yearBegan: 2018, yearEnded: null, format: "trade paperback", issues: [{ id: "20", descriptor: "1" }] },
          ];
        }
        if (name === "The Department of Truth") {
          return [
            { id: "3", name: "The Department of Truth", yearBegan: 2020, yearEnded: null, format: "ongoing series", issues: [{ id: "31", descriptor: "1" }] },
            { id: "4", name: "The Department of Truth", yearBegan: 2021, yearEnded: null, format: "trade paperback", issues: [{ id: "30", descriptor: "1" }] },
          ];
        }
        return [];
      },
      async issue(id) {
        asked.push(`issue:${id}`);
        if (id === "20") return godTrade;
        if (id === "10") return godSingle;
        if (id === "30") return truthTrade;
        if (id === "31") return truthSingle;
        return null;
      },
      async issuesByBarcode() {
        asked.push("barcode");
        return [];
      },
    };

    const byIsbn = await resolveGcdCover(godCountry(), catalog);
    expect(byIsbn).toMatchObject({ status: "matched", issue: { id: "20" } });
    expect(asked).not.toContain("issue:10");
    expect(asked).not.toContain("barcode");

    asked.length = 0;
    const byName = await resolveGcdCover(godCountry({ barcode: null }), catalog);
    expect(byName).toMatchObject({ status: "matched", issue: { id: "20" } });
    expect(asked).not.toContain("issue:10");

    asked.length = 0;
    const onlySingle: GcdCatalog = {
      ...catalog,
      async seriesByName() {
        return [{ id: "1", name: "God Country", yearBegan: 2017, yearEnded: 2017, format: "limited series", issues: [{ id: "10", descriptor: "1" }] }];
      },
    };
    const missed = await resolveGcdCover(godCountry({ barcode: null }), onlySingle);
    expect(missed.status).toBe("unmatched");

    const truthHit = await resolveGcdCover(truth(), catalog);
    expect(truthHit).toMatchObject({ status: "matched", issue: { id: "30" } });
  });

  it("matches collected editions on Comic Vine by ISBN, then name and volume", async () => {
    const isbnPaths: string[] = [];
    const byIsbn = await searchComicVineMatches({
      apiKey: "cv-key",
      query: "God Country TP-A",
      barcode: "9781534302341",
      mode: "query",
      shelfFormat: "single",
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        isbnPaths.push(`${parsed.pathname}?${parsed.searchParams.get("query") ?? ""}`);
        return Response.json({
          status_code: 1,
          results: [{ id: 20, name: "God Country", issue_number: "1", cover_date: "2018", volume: { id: 2, name: "God Country" } }],
        });
      },
    });
    expect(byIsbn[0]?.id).toBe("20");
    expect(isbnPaths).toHaveLength(1);
    expect(isbnPaths[0]).toContain("/search/");
    expect(isbnPaths[0]).toContain("9781534302341");

    const namePaths: string[] = [];
    const byName = await searchComicVineMatches({
      apiKey: "cv-key",
      query: "The Department of Truth TP",
      barcode: "",
      mode: "query",
      shelfFormat: "tp",
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        namePaths.push(`${parsed.pathname}?${parsed.searchParams.get("query") ?? ""} ${parsed.searchParams.get("filter") ?? ""}`.trim());
        if (parsed.pathname.endsWith("/search/") && parsed.searchParams.get("resources") === "volume") {
          return Response.json({ status_code: 1, results: [{ id: 4, name: "The Department of Truth", start_year: 2021 }] });
        }
        if (parsed.pathname.endsWith("/issues/")) {
          return Response.json({
            status_code: 1,
            results: [{ id: 30, name: "Volume 1", issue_number: "1", cover_date: "2021", volume: { id: 4, name: "The Department of Truth" } }],
          });
        }
        return Response.json({ status_code: 1, results: [] });
      },
    });
    expect(byName[0]?.id).toBe("30");
    expect(namePaths[0]).toContain("The Department of Truth Vol. 1");
    expect(namePaths.some((path) => path.includes("issue_number:1"))).toBe(true);
    expect(namePaths.some((path) => path.includes("978"))).toBe(false);
  });
});
