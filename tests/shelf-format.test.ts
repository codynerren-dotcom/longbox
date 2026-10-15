import { describe, expect, it } from "vitest";
import type { GcdCatalog, GcdIssueRow, GcdSeriesRow } from "@/lib/catalog/gcd";
import { searchMetronMatches } from "@/lib/catalog/match-search";
import { emptyBudget, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import { resolveCover } from "@/lib/covers/match";
import { resolveGcdCover } from "@/lib/covers/gcd-match";
import type { MetronTransport } from "@/lib/covers/metron-client";
import type { CoverLookup, CoverQuery, MetronIssueHit, MetronSeriesHit } from "@/lib/covers/types";
import { issueBadge } from "@/lib/series-view";
import { mapMetronDetails } from "@/lib/covers/enrich";
import {
  detectShelfFormat,
  formatCollectedList,
  metronSeriesType,
  readCollectedIssues,
  resolveShelfFormat,
  seriesHeaderFormat,
  tradeSearchSeries,
  volumeLabel,
} from "@/lib/shelf-format";

const query = (overrides: Partial<CoverQuery> = {}): CoverQuery => ({
  series: "The Department of Truth TP",
  issueNo: "1",
  issue: "1",
  coverYear: 2021,
  barcode: null,
  variant: null,
  publisher: "Image",
  shelfFormat: "tp",
  ...overrides,
});

function seriesHit(id: string, name: string): MetronSeriesHit {
  return { id, name, yearBegan: 2020, yearEnd: null, publisher: "Image" };
}

function issueHit(id: string, seriesName: string): MetronIssueHit {
  return {
    id,
    seriesId: "9",
    seriesName,
    number: "1",
    coverYear: 2021,
    imageUrl: "https://example.com/tp.jpg",
    label: null,
  };
}

describe("shelf format detection", () => {
  it("reads a trailing TP or HC and a CLZ format column", () => {
    expect(detectShelfFormat({ series: "The Department of Truth TP" })).toBe("tp");
    expect(detectShelfFormat({ series: "Saga HC" })).toBe("hc");
    expect(detectShelfFormat({ format: "Trade Paperback", series: "Saga" })).toBe("tp");
    expect(detectShelfFormat({ format: "Hardcover" })).toBe("hc");
    expect(detectShelfFormat({ format: "Omnibus" })).toBe("omnibus");
    expect(detectShelfFormat({ series: "Monstress Compendium" })).toBe("compendium");
    expect(detectShelfFormat({ title: "An original graphic novel" })).toBe("gn");
  });

  it("keeps a floppy in a Vol. series when the format column says Comic", () => {
    expect(detectShelfFormat({ format: "Comic", series: "Avengers, Vol. 8", issue: "7", issueNo: "7" })).toBe("single");
  });

  it("treats Vol. numbering and an ISBN as a trade when the format column is empty", () => {
    expect(detectShelfFormat({ issue: "Vol. 1", issueNo: "Vol. 1" })).toBe("tp");
    expect(detectShelfFormat({ barcode: "9781534318331" })).toBe("tp");
    expect(volumeLabel("1")).toBe("Vol. 1");
    expect(issueBadge("1", "A", "tp")).toBe("Vol. 1");
    expect(issueBadge("1", "A")).toBe("#1A");
  });

  it("trusts a stored choice and strips the trade suffix for search", () => {
    expect(resolveShelfFormat({ shelfFormat: "single", series: "The Department of Truth TP" })).toBe("single");
    expect(tradeSearchSeries("The Department of Truth TP")).toBe("The Department of Truth");
    expect(tradeSearchSeries("Saga (TP)")).toBe("Saga");
    expect(metronSeriesType("tp")).toBe("Trade Paperback");
    expect(metronSeriesType("hc")).toBe("Hardcover");
    expect(metronSeriesType("omnibus")).toBe("Omnibus");
    expect(metronSeriesType("gn")).toBe("Trade Paperback");
    expect(seriesHeaderFormat(["tp", "tp"])).toBe("tp");
    expect(seriesHeaderFormat(["tp", "single"])).toBeNull();
  });

  it("collapses the singles a trade collects", () => {
    expect(
      formatCollectedList([
        { series: "Saga", number: "1" },
        { series: "Saga", number: "2" },
        { series: "Saga", number: "3" },
      ]),
    ).toBe("Saga #1-3");
    expect(
      readCollectedIssues({
        reprints: [
          { series: { name: "Saga" }, number: "1" },
          { series: { name: "Saga" }, number: "2" },
        ],
      }),
    ).toBe("Saga #1-2");
    expect(mapMetronDetails({ id: 9, number: "1", series: { name: "Saga" }, reprints: [{ series: { name: "Saga" }, number: "4" }] })?.collects).toBe(
      "Saga #4",
    );
  });
});

describe("collected catalog search", () => {
  it("looks up an ISBN and a Trade Paperback series instead of the floppy", async () => {
    const calls: string[] = [];
    const lookup: CoverLookup = {
      async issuesByUpc() {
        calls.push("upc");
        return [];
      },
      async issuesByUpcPrefix() {
        return [];
      },
      async issuesByIsbn(isbn) {
        calls.push(`isbn:${isbn}`);
        return [issueHit("40", "The Department of Truth")];
      },
      async searchSeries(name) {
        calls.push(`series:${name}`);
        return [seriesHit("1", "The Department of Truth")];
      },
      async searchSeriesByType(name, seriesType) {
        calls.push(`typed:${name}:${seriesType}`);
        return [seriesHit("2", "The Department of Truth")];
      },
      async issuesForSeries() {
        calls.push("issues");
        return [];
      },
    };
    await resolveCover(query({ barcode: "9781534318331" }), lookup);
    expect(calls[0]).toBe("isbn:9781534318331");
    expect(calls.some((call) => call.startsWith("series:"))).toBe(false);

    calls.length = 0;
    await resolveCover(query(), lookup);
    expect(calls).toContain("typed:The Department of Truth:Trade Paperback");
    expect(calls.some((call) => call.startsWith("series:"))).toBe(false);
    expect(calls).toContain("issues");

    calls.length = 0;
    const empty: CoverLookup = { ...lookup, async searchSeriesByType() { calls.push("typed-empty"); return []; } };
    const missed = await resolveCover(query(), empty);
    expect(missed.status).toBe("unmatched");
    expect(calls).toEqual(["typed-empty"]);
  });

  it("asks Metron for series_type and isbn", async () => {
    const paths: string[] = [];
    const transport = metronTransport(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.includes("/series/")) {
        return Response.json({ results: [{ id: 15, name: "Saga", year_began: 2012 }] });
      }
      return Response.json({
        results: [{ id: 40, number: "1", series: { id: 15, name: "Saga" }, image: "https://example.com/a.jpg" }],
      });
    });
    const hits = await searchMetronMatches(transport, "Saga TP #1", "", "query", "tp");
    expect(paths[0]).toContain("series_type=Trade+Paperback");
    expect(paths[0]).toContain("name=Saga");
    expect(paths[1]).toContain("series_id=15");
    expect(hits[0]?.id).toBe("40");

    paths.length = 0;
    await searchMetronMatches(transport, "", "9781534318331", "barcode", "tp");
    expect(paths[0]).toContain("/issue/?isbn=9781534318331");
  });

  it("prefers a GCD trade series and an ISBN barcode", async () => {
    const floppy: GcdSeriesRow = { id: "1", name: "Saga", yearBegan: 2012, yearEnded: null, format: "ongoing series", issues: [{ id: "10", descriptor: "1" }] };
    const trade: GcdSeriesRow = { id: "2", name: "Saga", yearBegan: 2014, yearEnded: null, format: "trade paperback", issues: [{ id: "20", descriptor: "1" }] };
    const issue: GcdIssueRow = {
      id: "20",
      seriesId: "2",
      seriesName: "Saga",
      number: "1",
      variant: null,
      title: "Volume 1",
      coverDate: "2014",
      coverYear: 2014,
      onSaleYear: 2014,
      onSaleDate: null,
      price: "9.99",
      pageCount: 160,
      barcode: "9781607068064",
      publisher: "Image",
      writer: "Brian K. Vaughan",
      artist: "Fiona Staples",
      coverArtist: "Fiona Staples",
      characters: null,
      seriesYear: 2014,
      comicvineIssueId: null,
      metronIssueId: null,
    };
    const asked: string[] = [];
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        asked.push(name);
        return [floppy, trade];
      },
      async issue(id) {
        return id === "20" ? issue : { ...issue, id, seriesId: "1" };
      },
      async issuesByBarcode(code) {
        asked.push(`barcode:${code}`);
        return code.startsWith("978") ? [issue] : [];
      },
    };
    const found = await resolveGcdCover(query({ series: "Saga TP", barcode: "9781607068064", coverYear: 2014 }), catalog);
    expect(found.status).toBe("matched");
    if (found.status === "matched") expect(found.issue.id).toBe("20");
    expect(asked[0]).toBe("barcode:9781607068064");

    asked.length = 0;
    const byName = await resolveGcdCover(query({ series: "Saga TP", barcode: null, coverYear: 2014 }), catalog);
    expect(asked).toContain("Saga");
    expect(byName.status).toBe("matched");
    if (byName.status === "matched") expect(byName.issue.seriesId).toBe("2");
  });
});

function metronTransport(fetchImpl: typeof fetch): MetronTransport {
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
    limiter: new MetronLimiter(
      store,
      () => time,
      async (ms) => {
        time += ms;
      },
      () => "2026-10-15",
    ),
    username: "reader",
    password: "secret",
    baseUrl: "https://metron.cloud/api",
    now: () => time,
    fetch: fetchImpl,
  };
}
