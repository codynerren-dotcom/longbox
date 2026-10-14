import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSeriesRows,
  copyCountLabel,
  haveRange,
  isKeyIssue,
  issueBadge,
  majorityPublisher,
  ownedIssueCount,
  seriesSpend,
  variantLetter,
  yearSpan,
  type SeriesCopy,
} from "@/lib/series-view";

function copy(overrides: Partial<SeriesCopy> & Pick<SeriesCopy, "id">): SeriesCopy {
  return {
    series: "Saga",
    publisher: "Image",
    issueNo: "1",
    variant: null,
    variantDescription: null,
    releaseDate: null,
    coverDate: null,
    coverYear: null,
    releaseYear: null,
    seriesYear: null,
    coverUrl: null,
    keyLevel: "No",
    rawOrSlabbed: null,
    read: false,
    quantity: 1,
    purchasePrice: null,
    ...overrides,
  };
}

describe("series rows", () => {
  it("reads a variant letter from a single letter or a Cover label", () => {
    expect(variantLetter("A", "Regular Inhyuk Lee Cover")).toBe("A");
    expect(variantLetter("b", null)).toBe("B");
    expect(variantLetter("Cover B", null)).toBe("B");
    expect(variantLetter(null, "Cover G")).toBe("G");
    expect(variantLetter(null, "Regular Inhyuk Lee Cover")).toBe("");
    expect(variantLetter(null, "2-Per-Store Premiere Variant")).toBe("");
    expect(issueBadge("1", "A")).toBe("#1A");
    expect(issueBadge("1", "G")).toBe("#1G");
    expect(issueBadge("1", "R")).toBe("#1R");
    expect(issueBadge("1", "")).toBe("#1");
    expect(issueBadge("1A", "A")).toBe("#1A");
    expect(issueBadge("10", "A")).toBe("#10A");
  });

  it("lists one row per copy, sorted by issue number then variant letter", () => {
    const { rows, missing, collapsed } = buildSeriesRows(
      [
        copy({ id: "r", issueNo: "1", variant: "R", variantDescription: "Retailer incentive" }),
        copy({ id: "a2", issueNo: "1", variant: "A", variantDescription: "Second printing" }),
        copy({ id: "g", issueNo: "1", variant: "G", variantDescription: "2-Per-Store Premiere Variant" }),
        copy({ id: "a1", issueNo: "1", variant: "A", variantDescription: "Regular Inhyuk Lee Cover", keyLevel: "Major" }),
        copy({ id: "two", issueNo: "2", variant: null, variantDescription: null }),
        copy({ id: "ten", issueNo: "10", variant: "A" }),
      ],
      [],
    );

    expect(collapsed).toBe(false);
    expect(missing).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
    const owned = rows.filter((row) => row.kind === "owned");
    expect(owned.map((row) => row.badge)).toEqual(["#1A", "#1A", "#1G", "#1R", "#2", "#10A"]);
    expect(owned.map((row) => (row.kind === "owned" ? row.description : null))).toEqual([
      "Regular Inhyuk Lee Cover",
      "Second printing",
      "2-Per-Store Premiere Variant",
      "Retailer incentive",
      null,
      null,
    ]);
    expect(owned[0]?.key).toBe(true);
    expect(rows.map((row) => (row.kind === "owned" ? row.badge : `missing ${row.issueNo}`))).toEqual([
      "#1A",
      "#1A",
      "#1G",
      "#1R",
      "#2",
      "missing 3",
      "missing 4",
      "missing 5",
      "missing 6",
      "missing 7",
      "missing 8",
      "missing 9",
      "#10A",
    ]);
  });

  it("marks wishlisted gaps and keeps a letter-less copy ahead of lettered ones", () => {
    const { rows } = buildSeriesRows(
      [
        copy({ id: "letter", issueNo: "1", variant: "A" }),
        copy({ id: "plain", issueNo: "1", variant: null, variantDescription: "Regular Inhyuk Lee Cover" }),
        copy({ id: "three", issueNo: "3" }),
      ],
      ["2"],
    );
    expect(rows.map((row) => (row.kind === "owned" ? row.badge : row.issueNo))).toEqual(["#1", "#1A", "2", "#3"]);
    expect(rows[0]).toMatchObject({ description: "Regular Inhyuk Lee Cover" });
    expect(rows[2]).toMatchObject({ kind: "missing", wishlisted: true });
  });

  it("does not emit a row for every gap when the span is wider than the cap", () => {
    const { rows, missing, collapsed } = buildSeriesRows(
      [copy({ id: "first", issueNo: "1" }), copy({ id: "last", issueNo: "400" })],
      [],
      150,
    );
    expect(collapsed).toBe(true);
    expect(rows).toHaveLength(2);
    expect(missing).toHaveLength(398);
    expect(rows.every((row) => row.kind === "owned")).toBe(true);
  });

  it("summarizes the run for the header strip", () => {
    const comics = [
      copy({ id: "a", issueNo: "1", quantity: 2, purchasePrice: "4.99", coverYear: 2012, read: true }),
      copy({ id: "b", issueNo: "12", purchasePrice: "3.00", releaseYear: 2021, keyLevel: "Minor" }),
      copy({ id: "c", issueNo: "1", variant: "A", seriesYear: 1800, publisher: "Image" }),
      copy({ id: "annual", issueNo: "Annual 1", publisher: "Other" }),
    ];
    expect(copyCountLabel(comics)).toBe("5 comics");
    expect(copyCountLabel([copy({ id: "only" })])).toBe("1 comic");
    expect(haveRange(comics)).toBe("Have: 1-12");
    expect(haveRange([copy({ id: "only", issueNo: "5" })])).toBe("Have: 5");
    expect(ownedIssueCount(comics)).toBe(3);
    expect(yearSpan(comics)).toBe("2012\u20132021");
    expect(seriesSpend(comics)).toBe("12.98");
    expect(majorityPublisher(comics)).toBe("Image");
    expect(isKeyIssue("Major")).toBe(true);
    expect(isKeyIssue("No")).toBe(false);
    expect(isKeyIssue(null)).toBe(false);
  });

  it("does not group copies under one tile on the series page", () => {
    const page = readFileSync("src/app/series/[seriesId]/page.tsx", "utf8");
    const rows = readFileSync("src/app/series/series-rows.tsx", "utf8");
    expect(page).not.toMatch(/copies/);
    expect(page).not.toMatch(/owned\.map/);
    expect(rows).not.toMatch(/copies/);
    expect(rows).toMatch(/min-w-0/);
    expect(rows).toMatch(/truncate/);
  });
});
