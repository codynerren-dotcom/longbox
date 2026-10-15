import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGcdIssue, parseGcdSeries, type GcdCatalog, type GcdIssueRow, type GcdSeriesRow } from "@/lib/catalog/gcd";
import { mergeShelfSeries } from "@/lib/catalog/link-issue";
import { gcdCollectedQueries, resolveGcdCover, searchGcdMatches } from "@/lib/covers/gcd-match";
import type { CoverQuery } from "@/lib/covers/types";
import { seriesNamesMatch } from "@/lib/shelf-format";

const baneQuery = "Batman: Vengeance of Bane Facsimile Edition #1 2023";
const baneBarcode = "76194137966100111";
const tradeSeries = "Beneath the Trees: Where Nobody Sees - Rite of Spring";
const tradeIsbn = "9798887243849";

function recordedSeries(file: string): GcdSeriesRow[] {
  const fixture = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as { series: { results: unknown[] } };
  return fixture.series.results.map((row) => parseGcdSeries(row)).filter((row): row is GcdSeriesRow => row !== null);
}

describe("recorded GCD responses", () => {
  const baneFixture = JSON.parse(readFileSync(new URL("../fixtures/gcd/vengeance-of-bane.json", import.meta.url), "utf8")) as {
    series: { results: unknown[] };
    issue: unknown;
  };
  const baneSeries = baneFixture.series.results.map((row) => parseGcdSeries(row)).filter((row): row is GcdSeriesRow => row !== null);
  const baneIssue = parseGcdIssue(baneFixture.issue);
  const tradeSeriesRows = recordedSeries("../fixtures/gcd/rite-of-spring-tp.json");
  const tradeFixture = JSON.parse(readFileSync(new URL("../fixtures/gcd/rite-of-spring-tp.json", import.meta.url), "utf8")) as {
    issue: unknown;
    otherIssue: unknown;
  };
  const tradeIssue = parseGcdIssue(tradeFixture.issue);
  const otherTrade = parseGcdIssue(tradeFixture.otherIssue);

  it("matches the Bane facsimile from the base name and the issue barcode", async () => {
    expect(baneIssue?.id).toBe("2513854");
    expect(baneIssue?.barcode).toBe(baneBarcode);
    expect(baneSeries.find((row) => row.id === "198517")?.name).toBe("Batman: Vengeance of Bane 1 (Facsimile Edition)");

    const asked: string[] = [];
    const fetched: string[] = [];
    let barcodeCalls = 0;
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        asked.push(name);
        if (/facsimile|2023|#/i.test(name)) return [];
        if (!/vengeance of bane/i.test(name)) return [];
        return [
          ...baneSeries,
          {
            id: "distractor",
            name: "Batman: Vengeance of Bane 1 Facsimile",
            yearBegan: 2023,
            yearEnded: 2023,
            format: "one-shot",
            issues: [{ id: "999", descriptor: "" }],
          },
        ];
      },
      async issue(id) {
        fetched.push(id);
        if (id === "2513854") return baneIssue;
        if (id === "2514867") {
          return { ...(baneIssue as GcdIssueRow), id, barcode: "76194137966100121", variant: "Foil Cardstock Cover" };
        }
        return null;
      },
      async issuesByBarcode() {
        barcodeCalls += 1;
        return [];
      },
    };

    const byQuery = await searchGcdMatches(baneQuery, baneBarcode, "query", null, { catalog });
    expect(byQuery.map((hit) => hit.id)).toEqual(["2513854", "2514867"]);
    expect(byQuery[0]?.series).toContain("(Facsimile Edition)");
    expect(asked[0]).toBe("Vengeance of Bane");
    expect(asked.some((name) => /facsimile/i.test(name))).toBe(false);
    expect(fetched).toEqual(["2513854", "2514867"]);
    expect(barcodeCalls).toBe(0);

    const byBarcode = await searchGcdMatches(baneQuery, baneBarcode, "barcode", null, { facsimile: true, catalog });
    expect(byBarcode.map((hit) => hit.id)).toEqual(["2513854", "2514867"]);
    expect(barcodeCalls).toBe(0);
  });

  it("matches the Rite of Spring trade by ISBN and skips the other printing", async () => {
    expect(tradeIssue?.id).toBe("2853617");
    expect(tradeIssue?.isbn).toBe("979-8-88724-384-9");
    expect(otherTrade?.id).toBe("2853616");
    expect(tradeSeriesRows.map((row) => row.id)).toEqual(expect.arrayContaining(["239303", "239304"]));

    let barcodeCalls = 0;
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        return /beneath the trees/i.test(name) ? tradeSeriesRows : [];
      },
      async issue(id) {
        if (id === "2853617") return tradeIssue;
        if (id === "2853616") return otherTrade;
        return null;
      },
      async issuesByBarcode() {
        barcodeCalls += 1;
        return [];
      },
    };

    const hits = await searchGcdMatches(`${tradeSeries} 2026`, tradeIsbn, "barcode", "tp", { catalog });
    expect(hits.map((hit) => hit.id)).toEqual(["2853617"]);
    expect(barcodeCalls).toBe(0);
  });
});

describe("Rite of Spring query forms", () => {
  const nameSearch = JSON.parse(readFileSync(new URL("../fixtures/gcd/beneath-the-trees.json", import.meta.url), "utf8")) as {
    count: number;
    results: unknown[];
  };
  const allSeries = nameSearch.results.map((row) => parseGcdSeries(row)).filter((row): row is GcdSeriesRow => row !== null);
  const tradeFixture = JSON.parse(readFileSync(new URL("../fixtures/gcd/rite-of-spring-tp.json", import.meta.url), "utf8")) as {
    issue: unknown;
    otherIssue: unknown;
  };
  const tradeIssue = parseGcdIssue(tradeFixture.issue);
  const otherTrade = parseGcdIssue(tradeFixture.otherIssue);
  const riteIds = new Set(["225911", "239303", "239304"]);
  const emptyNames = new Set([
    "Beneath the Trees: Where Nobody Sees - Rite of Spring",
    "Where Nobody Sees - Rite of Spring",
    "Beneath the Trees Where Nobody Sees Rite of Spring",
  ]);

  function rowsFor(name: string): GcdSeriesRow[] {
    if (emptyNames.has(name)) return [];
    if (name === "Beneath the Trees") return allSeries;
    if (name === "Beneath the Trees Where Nobody Sees") return allSeries.filter((row) => row.id !== "239416");
    if (
      name === "Beneath the Trees Where Nobody Sees: Rite of Spring" ||
      name === "Where Nobody Sees: Rite of Spring" ||
      name === "Rite of Spring"
    ) {
      return allSeries.filter((row) => riteIds.has(row.id));
    }
    return [];
  }

  function catalog(asked: string[], fetched: string[]): GcdCatalog {
    return {
      async seriesByName(name) {
        asked.push(name);
        return rowsFor(name);
      },
      async issue(id) {
        fetched.push(id);
        if (id === "2853617") return tradeIssue;
        if (id === "2853616") return otherTrade;
        return {
          id,
          seriesId: "205119",
          seriesName: "Beneath the Trees Where Nobody Sees",
          number: "1",
          variant: "Cover A",
          title: null,
          coverDate: null,
          coverYear: 2024,
          onSaleYear: 2024,
          onSaleDate: null,
          price: null,
          pageCount: null,
          barcode: "75960600000000111",
          isbn: null,
          publisher: "IDW Publishing",
          writer: null,
          artist: null,
          coverArtist: null,
          characters: null,
          seriesYear: 2024,
          comicvineIssueId: null,
          metronIssueId: null,
        };
      },
      async issuesByBarcode() {
        return [];
      },
    };
  }

  async function find(query: string, mode: "query" | "barcode", shelfSeries?: string) {
    const asked: string[] = [];
    const fetched: string[] = [];
    const hits = await searchGcdMatches(query, tradeIsbn, mode, "tp", {
      catalog: catalog(asked, fetched),
      shelfSeries,
    });
    return { hits, asked, fetched };
  }

  it("records that Beneath the Trees is a GCD prefix hit our token filter used to drop", () => {
    expect(nameSearch.count).toBe(9);
    expect(allSeries.map((row) => row.id)).toContain("239304");
    expect(seriesNamesMatch("Beneath the Trees", "Beneath the Trees Where Nobody Sees: Rite of Spring")).toBe(false);
    expect(gcdCollectedQueries(tradeSeries)).toEqual([
      "Beneath the Trees Where Nobody Sees: Rite of Spring",
      tradeSeries,
      "Where Nobody Sees: Rite of Spring",
      "Where Nobody Sees - Rite of Spring",
      "Rite of Spring",
      "Beneath the Trees",
    ]);
  });

  it("searches the shelf series for a barcode with an empty query", async () => {
    const asked: string[] = [];
    const hits = await searchGcdMatches("", "70985300001100111", "barcode", null, {
      catalog: {
        async seriesByName(name) {
          asked.push(name);
          return [];
        },
        async issue() {
          return null;
        },
        async issuesByBarcode() {
          return [];
        },
      },
      shelfSeries: "Spawn",
    });
    expect(hits).toEqual([]);
    expect(asked[0]).toBe("Spawn");
  });

  it("makes no GCD request when a barcode search has no shelf series", async () => {
    let called = false;
    const hits = await searchGcdMatches("", "70985300001100111", "barcode", null, {
      catalog: {
        async seriesByName() {
          called = true;
          return [];
        },
        async issue() {
          return null;
        },
        async issuesByBarcode() {
          return [];
        },
      },
    });
    expect(hits).toEqual([]);
    expect(called).toBe(false);
  });

  it("keeps a passed shelf series and fills a missing one from the stored comic", () => {
    expect(mergeShelfSeries("Spawn", "Ewoks")).toBe("Spawn");
    expect(mergeShelfSeries("  ", "The Ewoks")).toBe("The Ewoks");
    expect(mergeShelfSeries(null, null)).toBe("");
  });

  it("finds 2853617 from the ISBN alone by falling back to the shelf series", async () => {
    const { hits, asked, fetched } = await find("", "barcode", tradeSeries);
    expect(hits.map((hit) => hit.id)).toEqual(["2853617"]);
    expect(asked[0]).toBe("Beneath the Trees Where Nobody Sees: Rite of Spring");
    expect(fetched).not.toContain("2574374");
    expect(hits.some((hit) => hit.issueNo === "1")).toBe(false);
  });

  it.each([
    ["Beneath the Trees", "Beneath the Trees"],
    ["Beneath the Trees Where Nobody Sees", "Beneath the Trees Where Nobody Sees"],
    [tradeSeries, "Beneath the Trees Where Nobody Sees: Rite of Spring"],
    ["Where Nobody Sees - Rite of Spring", "Where Nobody Sees: Rite of Spring"],
    ["Rite of Spring", "Rite of Spring"],
  ])("finds 2853617 from %s", async (query, firstAsk) => {
    const { hits, asked, fetched } = await find(query, "query");
    expect(hits.map((hit) => hit.id)).toEqual(["2853617"]);
    expect(hits.map((hit) => hit.issueNo)).not.toContain("1");
    expect(asked[0]).toBe(firstAsk);
    expect(fetched).not.toContain("2574374");
    expect(fetched).toContain("2853617");
  });
});

describe("short catalog title follow-ups", () => {
  function gcdIssue(overrides: Partial<GcdIssueRow>): GcdIssueRow {
    return {
      id: "1",
      seriesId: "10",
      seriesName: "Doom Force Special",
      number: "1",
      variant: null,
      title: null,
      coverDate: "July 1992",
      coverYear: 1992,
      onSaleYear: 1992,
      onSaleDate: null,
      price: null,
      pageCount: null,
      barcode: null,
      publisher: "DC",
      writer: null,
      artist: null,
      coverArtist: null,
      characters: null,
      seriesYear: 1992,
      comicvineIssueId: null,
      metronIssueId: null,
      ...overrides,
    };
  }

  function copy(overrides: Partial<CoverQuery>): CoverQuery {
    return {
      series: "Doom Force",
      issueNo: "1",
      issue: "1",
      coverYear: 1992,
      barcode: null,
      variant: null,
      publisher: "DC",
      ...overrides,
    };
  }

  it("links a one-issue Special and leaves a longer series unmatched", async () => {
    const one: GcdSeriesRow = {
      id: "10",
      name: "Doom Force Special",
      yearBegan: 1992,
      yearEnded: 1992,
      format: "one-shot",
      issueCount: 1,
      issues: [{ id: "100", descriptor: "1" }],
    };
    const many: GcdSeriesRow = { ...one, id: "11", issueCount: 12, issues: [{ id: "100", descriptor: "1" }, { id: "101", descriptor: "2" }] };
    const catalog = (row: GcdSeriesRow): GcdCatalog => ({
      async seriesByName() {
        return [row];
      },
      async issue(id) {
        return id === "100" ? gcdIssue({ id }) : null;
      },
      async issuesByBarcode() {
        return [];
      },
    });
    const matched = await resolveGcdCover(copy({}), catalog(one));
    expect(matched).toMatchObject({ status: "matched", issue: { id: "100" } });
    const refused = await resolveGcdCover(copy({}), catalog(many));
    expect(refused.status).toBe("unmatched");
  });

  it("uses the cover year as the GCD issue number when the shelf issue is 1 or blank", async () => {
    const series: GcdSeriesRow = {
      id: "20",
      name: "Marvel Annual Report",
      yearBegan: 1991,
      yearEnded: 1995,
      format: "ongoing series",
      issueCount: 5,
      issues: [
        { id: "1991", descriptor: "1991" },
        { id: "1993", descriptor: "1993" },
      ],
    };
    const catalog: GcdCatalog = {
      async seriesByName() {
        return [series];
      },
      async issue(id) {
        return gcdIssue({
          id,
          seriesId: "20",
          seriesName: "Marvel Annual Report",
          number: id,
          coverYear: Number(id),
          coverDate: id,
          seriesYear: 1991,
          publisher: "Marvel",
        });
      },
      async issuesByBarcode() {
        return [];
      },
    };
    const shelf = { series: "Marvel Annual Report", publisher: "Marvel", coverYear: 1993, barcode: null };
    expect(await resolveGcdCover(copy({ ...shelf, issueNo: "1", issue: "1" }), catalog)).toMatchObject({ status: "matched", issue: { id: "1993" } });
    expect(await resolveGcdCover(copy({ ...shelf, issueNo: null, issue: null }), catalog)).toMatchObject({ status: "matched", issue: { id: "1993" } });
    expect((await resolveGcdCover(copy({ ...shelf, issueNo: "2", issue: "2" }), catalog)).status).toBe("unmatched");
  });

  it("asks GCD for the slash parts and Free Comic Book Day", async () => {
    const asked: string[] = [];
    const series: GcdSeriesRow = {
      id: "jb",
      name: "Just Beyond: Monstrosity Free Comic Book Day Special 2021",
      yearBegan: 2021,
      yearEnded: 2021,
      format: "one-shot",
      issueCount: 1,
      issues: [{ id: "jb1", descriptor: "1" }],
    };
    const hits = await searchGcdMatches("FCBD 2021 Just Beyond/Monstrosity #1", "", "query", null, {
      catalog: {
        async seriesByName(name) {
          asked.push(name);
          return /free comic book day/i.test(name) ? [series] : [];
        },
        async issue(id) {
          return gcdIssue({ id, seriesName: series.name, number: "1", coverYear: 2021, publisher: "Boom! Studios", seriesYear: 2021 });
        },
        async issuesByBarcode() {
          return [];
        },
      },
    });
    expect(asked).toContain("Just Beyond: Monstrosity Free Comic Book Day");
    expect(hits.map((hit) => hit.id)).toEqual(["jb1"]);
  });
});
