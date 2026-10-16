import { afterEach, describe, expect, it } from "vitest";
import { searchComicVineMatches, searchMetronMatches } from "@/lib/catalog/match-search";
import { matchQuery } from "@/lib/catalog/manual-link";
import type { GcdCatalog, GcdIssueRow, GcdSeriesRow } from "@/lib/catalog/gcd";
import { emptyBudget, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import { clearMetronDetailCache, createMetronCoverLookup, type MetronTransport } from "@/lib/covers/metron-client";
import { resetMetronCircuit } from "@/lib/covers/metron-circuit";
import { resolveGcdCover, searchGcdMatches } from "@/lib/covers/gcd-match";
import { resolveCover } from "@/lib/covers/match";
import type { CoverQuery } from "@/lib/covers/types";
import { catalogSeriesQuery, parseShelfSeries } from "@/lib/shelf-format";

const image = "https://static.metron.cloud/media/issue/avengers.jpg";

afterEach(() => {
  resetMetronCircuit();
  clearMetronDetailCache();
});

function transport(fetchImpl: MetronTransport["fetch"]): MetronTransport {
  const budget: MetronBudget = { ...emptyBudget(), day: "2026-10-16" };
  const store: BudgetStore = {
    read: () => ({ ...budget }),
    write: (next) => Object.assign(budget, next),
  };
  return {
    limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-16"),
    username: "cody",
    password: "saved-token",
    baseUrl: "https://metron.cloud/api",
    now: () => 0,
    fetch: fetchImpl,
  };
}

function metronIssue(id: string, volume: number, yearBegan: number, number = "1") {
  return {
    id,
    number,
    cover_date: "2018-05-01",
    image,
    series: { id, name: id.startsWith("cyber") ? "Cyberforce" : "Avengers", year_began: yearBegan, volume, publisher: { name: "Marvel" } },
  };
}

describe("volume titles", () => {
  it("prefills the match query without the volume and leaves the shelf name intact", () => {
    const shelf = "Cyberforce, Vol. 1";
    expect(matchQuery({ series: shelf, issueNo: "1", year: 1992 })).toBe("Cyberforce #1 1992");
    expect(shelf).toBe("Cyberforce, Vol. 1");
    expect(matchQuery({ series: "Alpha Flight, Vol. 1", issueNo: "15", year: 1983 })).toBe("Alpha Flight #15 1983");
    expect(matchQuery({ series: "Fantastic Four, Vol. 6", issueNo: "1", year: 2018 })).toBe("Fantastic Four #1 2018");
    expect(matchQuery({ series: "Avengers, Vol. 8", issueNo: "7", year: 2018 })).toBe("Avengers #7 2018");
    expect(parseShelfSeries("Cyberforce Vol 1")).toMatchObject({ name: "Cyberforce", volume: 1 });
    expect(parseShelfSeries("Cyberforce Volume 1")).toMatchObject({ name: "Cyberforce", volume: 1 });
    expect(parseShelfSeries("Cyberforce (Vol. 1)")).toMatchObject({ name: "Cyberforce", volume: 1 });
    expect(catalogSeriesQuery("Avengers #7", "Avengers, Vol. 8")).toMatchObject({ name: "Avengers #7", volume: null });
    expect(catalogSeriesQuery("Avengers", "Avengers, Vol. 8")).toMatchObject({ name: "Avengers", volume: 8 });
  });

  it("queries Metron by the stripped name and ranks Avengers Vol. 8 over 1963", async () => {
    const cases = [
      { query: "Cyberforce, Vol. 1 #1 1992", name: "Cyberforce", volume: "1", id: "11" },
      { query: "Alpha Flight, Vol. 1 #15 1983", name: "Alpha Flight", volume: "1", id: "12" },
      { query: "Fantastic Four, Vol. 6 #1 2018", name: "Fantastic Four", volume: "6", id: "13" },
    ];
    for (const item of cases) {
      const urls: string[] = [];
      const hits = await searchMetronMatches(
        transport(async (url) => {
          urls.push(String(url));
          return Response.json({
            results: [{ id: item.id, number: "1", cover_date: "1992", image, series: { id: item.id, name: item.name, volume: Number(item.volume) } }],
          });
        }),
        item.query,
        "",
        "query",
      );
      expect(urls).toHaveLength(1);
      const params = new URL(urls[0] ?? "").searchParams;
      expect(params.get("series_name")).toBe(item.name);
      expect(params.get("volume")).toBe(item.volume);
      expect(params.has("series_year_began")).toBe(false);
      expect(params.get("series_name")).not.toMatch(/vol/i);
      expect(hits[0]?.id).toBe(item.id);
    }

    const urls: string[] = [];
    const hits = await searchMetronMatches(
      transport(async (url) => {
        urls.push(String(url));
        return Response.json({
          results: [metronIssue("1963", 1, 1963, "7"), metronIssue("2018", 8, 2018, "7")],
        });
      }),
      "Avengers #7 2018",
      "",
      "query",
      null,
      "Avengers, Vol. 8",
    );
    expect(urls).toHaveLength(1);
    const params = new URL(urls[0] ?? "").searchParams;
    expect(params.get("series_name")).toBe("Avengers");
    expect(params.get("volume")).toBe("8");
    expect(params.has("series_year_began")).toBe(false);
    expect(hits.map((hit) => hit.id)).toEqual(["2018", "1963"]);
  });

  it("matches Avengers Vol. 8 on Metron in one request", async () => {
    const urls: string[] = [];
    const client = transport(async (url) => {
      urls.push(String(url));
      return Response.json({
        results: [metronIssue("1963", 1, 1963, "7"), metronIssue("2018", 8, 2018, "7")],
      });
    });
    const comic: CoverQuery = {
      series: "Avengers, Vol. 8",
      issueNo: "7",
      issue: "7",
      coverYear: 2018,
      barcode: null,
      variant: null,
      publisher: "Marvel",
    };
    const decision = await resolveCover(comic, createMetronCoverLookup(client));
    expect(decision).toMatchObject({ status: "matched", issue: { id: "2018" } });
    expect(urls).toHaveLength(1);
    const params = new URL(urls[0] ?? "").searchParams;
    expect(params.get("series_name")).toBe("Avengers");
    expect(params.get("volume")).toBe("8");
    expect(params.get("series_name")).not.toMatch(/vol/i);
  });

  it("asks GCD and Comic Vine for the stripped name and keeps the 2018 Avengers series", async () => {
    const asked: string[] = [];
    const issue = (id: string, year: number): GcdIssueRow => ({
      id,
      seriesId: id,
      seriesName: "Avengers",
      number: "7",
      variant: null,
      title: null,
      coverDate: "2018",
      coverYear: 2018,
      onSaleYear: year,
      onSaleDate: null,
      price: null,
      pageCount: null,
      barcode: null,
      publisher: "Marvel",
      writer: null,
      artist: null,
      coverArtist: null,
      characters: null,
      seriesYear: year,
      comicvineIssueId: null,
      metronIssueId: null,
    });
    const series = (id: string, year: number): GcdSeriesRow => ({
      id,
      name: "Avengers",
      yearBegan: year,
      yearEnded: null,
      format: "ongoing series",
      issues: [{ id, descriptor: "7" }],
      publisher: "Marvel",
    });
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        asked.push(name);
        return name === "Avengers" ? [series("1963", 1963), series("2018", 2018)] : [];
      },
      async issue(id) {
        return id === "2018" || id === "1963" ? issue(id, id === "2018" ? 2018 : 1963) : null;
      },
      async issuesByBarcode() {
        return [];
      },
    };
    const hits = await searchGcdMatches("Avengers, Vol. 8 #7 2018", "", "query", null, { catalog });
    expect(asked).toEqual(["Avengers"]);
    expect(hits.map((hit) => hit.id)).toEqual(["2018"]);

    asked.length = 0;
    const comic: CoverQuery = {
      series: "Avengers, Vol. 8",
      issueNo: "7",
      issue: "7",
      coverYear: 2018,
      barcode: null,
      variant: null,
      publisher: "Marvel",
    };
    const decision = await resolveGcdCover(comic, catalog);
    expect(decision).toMatchObject({ status: "matched", issue: { id: "2018" } });
    expect(asked.every((name) => name === "Avengers")).toBe(true);
    expect(asked.some((name) => /vol/i.test(name))).toBe(false);

    const vine: string[] = [];
    await searchComicVineMatches({
      apiKey: "cv-key",
      query: "Avengers, Vol. 8 #7 2018",
      barcode: "",
      mode: "query",
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        vine.push(`${parsed.pathname} ${parsed.searchParams.get("query") ?? ""} ${parsed.searchParams.get("filter") ?? ""}`.trim());
        if (parsed.pathname.endsWith("/search/")) {
          return Response.json({
            status_code: 1,
            results: [
              { id: 1963, name: "Avengers", start_year: 1963 },
              { id: 2018, name: "Avengers", start_year: 2018 },
            ],
          });
        }
        return Response.json({
          status_code: 1,
          results: [{ id: 77, issue_number: "7", cover_date: "2018-05-02", volume: { id: 2018, name: "Avengers" } }],
        });
      },
    });
    expect(vine[0]).toContain("Avengers");
    expect(vine[0]).not.toMatch(/vol\./i);
    expect(vine.some((line) => line.includes("volume:2018"))).toBe(true);
    expect(vine.some((line) => line.includes("volume:1963"))).toBe(false);
  });
});
