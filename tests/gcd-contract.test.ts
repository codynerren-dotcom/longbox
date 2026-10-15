import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGcdIssue, parseGcdSeries, type GcdCatalog, type GcdIssueRow, type GcdSeriesRow } from "@/lib/catalog/gcd";
import { searchGcdMatches } from "@/lib/covers/gcd-match";

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
    expect(byQuery.map((hit) => hit.id)).toEqual(["2513854"]);
    expect(byQuery[0]?.series).toContain("(Facsimile Edition)");
    expect(asked[0]).toBe("Vengeance of Bane");
    expect(asked.some((name) => /facsimile/i.test(name))).toBe(false);
    expect(fetched).toEqual(["2513854", "2514867"]);
    expect(barcodeCalls).toBe(0);

    const byBarcode = await searchGcdMatches(baneQuery, baneBarcode, "barcode", null, { facsimile: true, catalog });
    expect(byBarcode.map((hit) => hit.id)).toEqual(["2513854"]);
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
