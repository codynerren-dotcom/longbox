import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SeriesSummary } from "@/app/series/series-summary";
import {
  buildSeriesRows,
  copyCountLabel,
  distinctIssueLabels,
  haveRange,
  isKeyIssue,
  issueBadge,
  majorityPublisher,
  ownedIssueCount,
  seriesHeaderSummary,
  seriesMissing,
  groupRowFacts,
  seriesRowFacts,
  seriesSpend,
  truncateMissingParts,
  variantLetter,
  yearSpan,
  type SeriesCopy,
} from "@/lib/series-view";

function eightBillionGeniesDescriptors(): string[] {
  const notes = ["Cover A - Ryan Browne", "Second Printing", "Bird City Comics Store Variant", "Facsimile"];
  const labels: string[] = [];
  for (let issue = 1; issue <= 8; issue += 1) {
    labels.push(String(issue));
    for (const note of notes) labels.push(`${issue} [${note}]`);
  }
  labels.push("1K", "2E", "3D");
  return labels;
}

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
    keyReason: null,
    title: null,
    storyArc: null,
    writer: null,
    coverArtist: null,
    grade: null,
    gradingCompany: null,
    rawOrSlabbed: null,
    storageBox: null,
    signedBy: null,
    read: false,
    quantity: 1,
    purchasePrice: null,
    value: null,
    myValue: null,
    priceQuote: null,
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

  it("lists only owned copies, sorted by issue number then variant letter", () => {
    const rows = buildSeriesRows([
      copy({ id: "r", issueNo: "1", variant: "R", variantDescription: "Retailer incentive" }),
      copy({ id: "a2", issueNo: "1", variant: "A", variantDescription: "Second printing" }),
      copy({ id: "g", issueNo: "1", variant: "G", variantDescription: "2-Per-Store Premiere Variant" }),
      copy({ id: "a1", issueNo: "1", variant: "A", variantDescription: "Regular Inhyuk Lee Cover", keyLevel: "Major" }),
      copy({ id: "two", issueNo: "2", variant: null, variantDescription: null }),
      copy({ id: "ten", issueNo: "10", variant: "A" }),
    ]);

    expect(rows.map((row) => row.badge)).toEqual(["#1A", "#1A", "#1G", "#1R", "#2", "#10A"]);
    expect(rows.map((row) => row.description)).toEqual([
      "Regular Inhyuk Lee Cover",
      "Second printing",
      "2-Per-Store Premiere Variant",
      "Retailer incentive",
      null,
      null,
    ]);
    expect(rows[0]?.key).toBe(true);
    expect(rows.every((row) => row.kind === "owned")).toBe(true);
  });

  it("keeps a letter-less copy ahead of lettered ones and skips numbers you do not own", () => {
    const rows = buildSeriesRows([
      copy({ id: "letter", issueNo: "1", variant: "A" }),
      copy({ id: "plain", issueNo: "1", variant: null, variantDescription: "Regular Inhyuk Lee Cover" }),
      copy({ id: "three", issueNo: "3" }),
    ]);
    expect(rows.map((row) => row.badge)).toEqual(["#1", "#1A", "#3"]);
    expect(rows[0]).toMatchObject({ description: "Regular Inhyuk Lee Cover" });
  });

  it("does not insert a row for every number in a wide span", () => {
    const rows = buildSeriesRows([copy({ id: "first", issueNo: "1" }), copy({ id: "last", issueNo: "400" })]);
    expect(rows.map((row) => row.badge)).toEqual(["#1", "#400"]);
  });

  it("summarizes the run for the header strip", () => {
    const comics = [
      copy({ id: "a", issueNo: "1", quantity: 2, purchasePrice: "4.99", coverYear: 2012, read: true }),
      copy({ id: "b", issueNo: "12", purchasePrice: "3.00", releaseYear: 2021, keyLevel: "Minor" }),
      copy({ id: "c", issueNo: "1", variant: "A", seriesYear: 1800, publisher: "Image" }),
      copy({ id: "annual", issueNo: "Annual 1", publisher: "Other" }),
    ];
    expect(copyCountLabel(comics)).toBe("3 issues · 5 copies");
    expect(copyCountLabel([copy({ id: "only" })])).toBe("1 issue");
    expect(haveRange(comics)).toBe("Have: #1, #12");
    expect(haveRange([copy({ id: "only", issueNo: "5" })])).toBe("Have: #5");
    expect(seriesMissing(comics, null)).toEqual({ kind: "missing", count: 10, parts: ["#2\u201311"] });
    expect(seriesMissing([copy({ id: "only", issueNo: "5" })], null)).toBeNull();
    expect(seriesMissing([copy({ id: "annual", issueNo: "Annual 1" })], null)).toBeNull();
    expect(ownedIssueCount(comics)).toBe(3);
    expect(yearSpan(comics)).toBe("2012\u20132021");
    expect(seriesSpend(comics)).toBe("12.98");
    expect(majorityPublisher(comics)).toBe("Image");
    expect(isKeyIssue("Major")).toBe(true);
    expect(isKeyIssue("No")).toBe(false);
    expect(isKeyIssue(null)).toBe(false);
  });

  it("collapses missing issue numbers into one header line", () => {
    const comics = ["1", "12", "14", "18", "19", "21"].map((issueNo, index) =>
      copy({ id: `n${index}`, issueNo, variant: index === 0 ? "A" : null }),
    );
    comics.push(copy({ id: "dup", issueNo: "12", variant: "B" }));
    expect(seriesMissing(comics, null)).toEqual({
      kind: "missing",
      count: 15,
      parts: ["#2\u201311", "#13", "#15\u201317", "#20"],
    });
    expect(
      seriesMissing(
        [copy({ id: "a", issueNo: "1" }), copy({ id: "b", issueNo: "2" }), copy({ id: "c", issueNo: "3" })],
        null,
      ),
    ).toBeNull();
    expect(seriesMissing([copy({ id: "first", issueNo: "1" }), copy({ id: "last", issueNo: "400" })], null)).toEqual({
      kind: "missing",
      count: 398,
      parts: ["#2\u2013399"],
    });
  });

  it("counts missing issues against the full series run", () => {
    const owned = [copy({ id: "a", issueNo: "1" }), copy({ id: "variant", issueNo: "1", variant: "B" })];
    const run = { numbers: ["1", "01", "2", "3", "4", "5"], issueCount: 20 };
    expect(distinctIssueLabels(run.numbers)).toEqual(["1", "2", "3", "4", "5"]);
    expect(seriesMissing(owned, run)).toEqual({ kind: "missing", count: 19, parts: ["#2\u201320"] });
    expect(seriesHeaderSummary(owned, run)).toBe("1 issue · 2 copies · Have: #1 · Missing 19: #2\u201320");
    expect(seriesHeaderSummary([copy({ id: "only", issueNo: "1" })], { numbers: ["1", "2", "3", "4", "5"], issueCount: null })).toBe(
      "1 issue · Have: #1 · Missing 4: #2\u20135",
    );
    expect(seriesMissing([copy({ id: "only", issueNo: "01" })], { numbers: ["1", "2"], issueCount: null })).toEqual({
      kind: "missing",
      count: 1,
      parts: ["#2"],
    });
    expect(
      seriesMissing([copy({ id: "a", issueNo: "1" }), copy({ id: "annual", issueNo: "Annual 1" })], {
        numbers: [],
        issueCount: 5,
      }),
    ).toEqual({ kind: "missing", count: 4, parts: ["#2\u20135"] });
    expect(
      seriesMissing([copy({ id: "a", issueNo: "1" }), copy({ id: "outside", issueNo: "8" })], { numbers: [], issueCount: 5 }),
    ).toEqual({ kind: "missing", count: 4, parts: ["#2\u20135"] });
    expect(seriesMissing([copy({ id: "a", issueNo: "1" })], { numbers: ["1", "2", "Annual 1", "1.5"], issueCount: null })).toEqual({
      kind: "missing",
      count: 3,
      parts: ["#2", "Annual 1", "1.5"],
    });
    expect(
      seriesMissing([copy({ id: "a", issueNo: "1" }), copy({ id: "annual", issueNo: "Annual 1" })], {
        numbers: ["1", "Annual 1"],
        issueCount: null,
      }),
    ).toBeNull();
    expect(seriesHeaderSummary([copy({ id: "a", issueNo: "1" }), copy({ id: "b", issueNo: "2" })], { numbers: ["1", "2"], issueCount: 9 })).toBe(
      "2 issues · Have: #1\u20132 · Missing 7: #3\u20139",
    );
    const genies = eightBillionGeniesDescriptors();
    expect(distinctIssueLabels(genies)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    const ownedGenies = [
      ...["1", "2", "3", "4", "5", "6", "7", "8"].map((issueNo, index) =>
        copy({ id: `genies-${index}`, series: "Eight Billion Genies", issueNo }),
      ),
      copy({ id: "genies-k", series: "Eight Billion Genies", issueNo: "1K", variantDescription: "Facsimile" }),
    ];
    const geniesRun = { numbers: genies, issueCount: 40 };
    expect(seriesMissing(ownedGenies, geniesRun)).toBeNull();
    expect(haveRange(ownedGenies)).toBe("Have: #1\u20138");
    expect(ownedIssueCount(ownedGenies)).toBe(8);
    expect(seriesHeaderSummary(ownedGenies, geniesRun)).toBe("8 issues · 9 copies · Have: #1\u20138");
    expect(seriesHeaderSummary(ownedGenies, geniesRun)).not.toContain("Missing");
    expect(seriesMissing(ownedGenies.slice(0, 7), geniesRun)).toEqual({ kind: "missing", count: 1, parts: ["#8"] });
    const pandora = ["1", "2", "3", "5", "6"].map((issueNo, index) =>
      copy({ id: `pandora-${index}`, series: "Frank Miller's Pandora", issueNo }),
    );
    expect(haveRange(pandora)).toBe("Have: #1\u20133, #5\u20136");
    expect(seriesMissing(pandora, null)).toEqual({ kind: "missing", count: 1, parts: ["#4"] });
    expect(seriesHeaderSummary(pandora, null)).toBe("5 issues · Have: #1\u20133, #5\u20136 · Missing 1: #4 · (catalog unknown)");
    expect(seriesHeaderSummary(pandora, null)).not.toContain("Gaps");
    const fantasticFour = [
      copy({ id: "ff-g", series: "Fantastic Four", issueNo: "3G" }),
      copy({ id: "ff-h", series: "Fantastic Four", issueNo: "3H" }),
      copy({ id: "ff-c", series: "Fantastic Four", issueNo: "10C" }),
      copy({ id: "ff-a", series: "Fantastic Four", issueNo: "17A" }),
    ];
    const fantasticFourRun = { numbers: [] as string[], issueCount: 48 };
    expect(haveRange(fantasticFour)).toBe("Have: #3, #10, #17");
    expect(seriesHeaderSummary(fantasticFour, fantasticFourRun)).toBe(
      "3 issues · 4 copies · Have: #3, #10, #17 · Missing 45: #1\u20132, #4\u20139, #11\u201316, #18\u201348",
    );
    expect(seriesHeaderSummary(fantasticFour, fantasticFourRun)).not.toContain("catalog unknown");
    expect(seriesHeaderSummary(fantasticFour, fantasticFourRun)).not.toContain("Gaps");
    expect(seriesHeaderSummary(fantasticFour, null)).toBe(
      "3 issues · 4 copies · Have: #3, #10, #17 · Missing 12: #4\u20139, #11\u201316 · (catalog unknown)",
    );
    expect(seriesMissing(pandora, { numbers: ["1", "2", "3", "4", "5", "6", "7", "8"], issueCount: 8 })).toEqual({
      kind: "missing",
      count: 3,
      parts: ["#4", "#7\u20138"],
    });
    const holes = ["1", "12", "14", "18", "19", "21"].map((issueNo, index) => copy({ id: `g${index}`, issueNo }));
    expect(seriesHeaderSummary(holes, null)).toBe(
      "6 issues · Have: #1, #12, #14, #18\u201319, #21 · Missing 15: #2\u201311, #13, #15\u201317, #20 · (catalog unknown)",
    );
    const parts = Array.from({ length: 20 }, (_, index) => `#${index + 2}`);
    const cut = truncateMissingParts(parts);
    expect(cut.shown.join(", ").length).toBeLessThanOrEqual(56);
    expect(cut.rest).toBeGreaterThan(0);
    expect(truncateMissingParts(["#2-5"]).rest).toBe(0);
  });

  it("hides empty row details and keeps the ones that are filled", () => {
    const bare = seriesRowFacts(copy({ id: "bare" }));
    expect(bare).toEqual({
      story: null,
      keyReason: null,
      creators: null,
      condition: null,
      copies: null,
      box: null,
      paid: null,
      basis: null,
      value: null,
      signed: null,
    });

    const full = seriesRowFacts(
      copy({
        id: "full",
        series: "Saga",
        title: "Saga",
        storyArc: "Chapter One",
        keyLevel: "Major",
        keyReason: "1st appearance of Hazel",
        writer: "Brian K. Vaughan",
        coverArtist: "Fiona Staples",
        grade: "9.8",
        gradingCompany: "CGC",
        rawOrSlabbed: "Slabbed",
        quantity: 2,
        storageBox: "Longbox A",
        purchasePrice: "9.99",
        value: "40.00",
        myValue: "45.00",
        signedBy: "Fiona Staples",
        priceQuote: { amount: "55.00", currency: "USD" },
      }),
    );
    expect(full.story).toBe("Chapter One");
    expect(full.keyReason).toBe("1st appearance of Hazel");
    expect(full.creators).toBe("Writer Brian K. Vaughan · Cover Fiona Staples");
    expect(full.condition).toEqual({ text: "CGC 9.8", slab: true });
    expect(full.copies).toBeNull();
    expect(full.basis).toBe("Cost $19.98");
    expect(full.box).toBe("Longbox A");
    expect(full.paid).toBe("Paid $9.99");
    expect(full.value).toBe("Value $55.00");
    expect(full.signed).toBe("Signed Fiona Staples");

    const raw = seriesRowFacts(
      copy({
        id: "raw",
        title: "The Wake",
        grade: "NM",
        rawOrSlabbed: "Raw",
        keyLevel: "No",
        keyReason: "Not a key",
        value: null,
        myValue: "12.00",
        coverArtist: "Fiona Staples",
      }),
    );
    expect(raw.story).toBe("The Wake");
    expect(raw.keyReason).toBeNull();
    expect(raw.creators).toBe("Cover Fiona Staples");
    expect(raw.condition).toEqual({ text: "Raw NM", slab: false });
    expect(raw.copies).toBeNull();
    expect(raw.paid).toBeNull();
    expect(raw.value).toBe("Value $12.00");
    expect(raw.signed).toBeNull();
    expect(raw.basis).toBeNull();
  });

  it("collapses duplicate copies of the same series, issue, and variant", () => {
    const rows = buildSeriesRows([
      copy({
        id: "a",
        series: "Alien",
        issueNo: "1",
        variant: "A",
        variantDescription: "Cover A",
        grade: "9.8",
        rawOrSlabbed: "Raw",
        storageBox: "Box 1",
        purchasePrice: "4.99",
      }),
      copy({
        id: "b",
        series: "Alien",
        issueNo: "1A",
        variant: null,
        variantDescription: "Cover A",
        grade: "9.6",
        gradingCompany: "CGC",
        rawOrSlabbed: "Slabbed",
        storageBox: "Box 2",
        purchasePrice: "9.99",
      }),
      copy({
        id: "other",
        series: "Alien",
        issueNo: "1",
        variant: "A",
        variantDescription: "Second printing",
        purchasePrice: "3.00",
      }),
    ]);
    expect(rows.map((row) => row.badge)).toEqual(["#1A", "#1A"]);
    expect(rows.map((row) => row.quantity)).toEqual([2, 1]);
    const grouped = rows[0];
    expect(grouped?.copies.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(grouped?.copies.find((item) => item.id === "a")?.grade).toBe("9.8");
    expect(grouped?.copies.find((item) => item.id === "b")?.grade).toBe("9.6");
    const facts = groupRowFacts(grouped?.copies ?? []);
    expect(facts.paid).toBe("Paid $4.99-$9.99");
    expect(facts.basis).toBe("Cost $14.98");
    expect(facts.condition).toEqual({ text: "mixed", slab: false });
    expect(facts.box).toBe("Box 1, Box 2");
    expect(facts.copies).toBeNull();

    const matched = groupRowFacts([
      copy({ id: "p1", purchasePrice: "4.99", grade: "NM", rawOrSlabbed: "Raw", storageBox: "Longbox A", signedBy: "Stan Lee" }),
      copy({ id: "p2", purchasePrice: "4.99", grade: "NM", rawOrSlabbed: "Raw", storageBox: "longbox a", signedBy: "Stan Lee" }),
    ]);
    expect(matched.paid).toBe("Paid $4.99");
    expect(matched.basis).toBe("Cost $9.98");
    expect(matched.condition).toEqual({ text: "Raw NM", slab: false });
    expect(matched.box).toBe("Longbox A");
    expect(matched.signed).toBe("Signed Stan Lee");

    const partial = groupRowFacts([
      copy({ id: "m1", purchasePrice: "4.99", signedBy: "Stan Lee" }),
      copy({ id: "m2", purchasePrice: null, signedBy: "Jack Kirby" }),
    ]);
    expect(partial.paid).toBe("Paid mixed");
    expect(partial.signed).toBeNull();

    const header = Array.from({ length: 14 }, (_, index) => copy({ id: `c${index}`, issueNo: String(index + 1) }));
    header.push(copy({ id: "dup", issueNo: "1" }));
    expect(copyCountLabel(header)).toBe("14 issues · 15 copies");
    expect(copyCountLabel([copy({ id: "pair", quantity: 2 })])).toBe("1 issue · 2 copies");
  });

  it("keeps grouped rows as separate records on the issue page", () => {
    const page = readFileSync("src/app/issues/[id]/page.tsx", "utf8");
    const action = readFileSync("src/app/issues/actions.ts", "utf8");
    const keys = readFileSync("src/app/keys/page.tsx", "utf8");
    const collection = readFileSync("src/app/collection/page.tsx", "utf8");
    expect(page).toMatch(/Copies/);
    expect(page).toMatch(/RemoveCopyButton/);
    expect(page).toMatch(/id="editor"/);
    expect(page).not.toMatch(/\u2014/);
    expect(action).toMatch(/comic\.delete/);
    expect(action).not.toMatch(/deleteMany/);
    expect(keys).toMatch(/groupCopies/);
    expect(keys).toMatch(/quantity=\{quantity\}/);
    expect(collection).toMatch(/copyCountLabel/);
    expect(collection).toMatch(/variantDescription: true/);
  });

  it("does not group copies under one tile on the series page", () => {
    const page = readFileSync("src/app/series/[seriesId]/page.tsx", "utf8");
    const rows = readFileSync("src/app/series/series-rows.tsx", "utf8");
    expect(page).not.toMatch(/owned\.length/);
    expect(page).not.toMatch(/owned\.map/);
    expect(page).toMatch(/SeriesSummary/);
    expect(page).toMatch(/seriesMissing/);
    expect(page).not.toMatch(/missingIssuesLabel/);
    expect(page).not.toMatch(/dashed/);
    const summary = readFileSync("src/app/series/series-summary.tsx", "utf8");
    expect(summary).toMatch(/flex-wrap/);
    expect(summary).toMatch(/min-w-0/);
    expect(summary).toMatch(/min-h-11/);
    expect(summary).toMatch(/show all/);
    expect(summary).not.toMatch(/\u2014/);
    const chip = renderToStaticMarkup(
      createElement(SeriesSummary, {
        copies: "1 comic",
        have: "Have: 1",
        missing: { kind: "missing", count: 4, parts: ["#2-5"] },
      }),
    );
    expect(chip).toContain("1 comic");
    expect(chip).toContain("Have: 1");
    expect(chip).toContain("Missing 4: #2-5");
    expect(chip).not.toContain("show all");
    const long = renderToStaticMarkup(
      createElement(SeriesSummary, {
        copies: "1 comic",
        have: "Have: 1",
        missing: { kind: "missing", count: 40, parts: Array.from({ length: 20 }, (_, index) => `#${index + 2}`) },
      }),
    );
    expect(long).toContain("Missing 40:");
    expect(long).toContain("show all");
    expect(long).toContain("min-h-11");
    expect(long).not.toContain("#21");
    const hidden = renderToStaticMarkup(
      createElement(SeriesSummary, { copies: "3 comics", have: "Have: 1-3", missing: null }),
    );
    expect(hidden).not.toContain("Missing");
    expect(hidden).not.toContain("Gaps");
    expect(rows).not.toMatch(/owned\.length/);
    expect(rows).not.toMatch(/[Mm]issing/);
    expect(rows).not.toMatch(/dashed/);
    expect(rows).toMatch(/md:hidden/);
    expect(rows).toMatch(/md:flex/);
    expect(rows).toMatch(/min-w-0/);
    expect(rows).toMatch(/truncate/);
  });
});
