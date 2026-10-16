import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGcdIssue, parseGcdSeries, type GcdCatalog, type GcdIssueRow, type GcdSeriesRow } from "@/lib/catalog/gcd";
import { parseGcdIssueRef } from "@/lib/catalog/gcd-ref";
import { linkUpdate } from "@/lib/catalog/link-plan";
import { readManualLink } from "@/lib/catalog/manual-link";
import { gcdDetails, gcdHit, gcdIssueFamilyKey, gcdVariantSiblingIds, loadGcdIssueHits, matchingGcdVariant, resolveGcdCover, searchGcdMatches } from "@/lib/covers/gcd-match";
import type { CoverQuery } from "@/lib/covers/types";

const baneFixture = JSON.parse(readFileSync(new URL("../fixtures/gcd/vengeance-of-bane.json", import.meta.url), "utf8")) as {
  series: { results: unknown[] };
  issue: unknown;
};
const foilFixture = JSON.parse(readFileSync(new URL("../fixtures/gcd/vengeance-of-bane-foil.json", import.meta.url), "utf8")) as {
  issue: unknown;
};

const series = baneFixture.series.results.map((row) => parseGcdSeries(row)).filter((row): row is GcdSeriesRow => row !== null);
const parent = parseGcdIssue(baneFixture.issue) as GcdIssueRow;
const foil = parseGcdIssue(foilFixture.issue) as GcdIssueRow;

function baneCatalog(): GcdCatalog {
  const facsimile = series.find((row) => row.id === "198517") ?? null;
  return {
    async seriesByName(name) {
      return /vengeance of bane/i.test(name) ? series : [];
    },
    async seriesById(id) {
      return id === "198517" ? facsimile : null;
    },
    async issue(id) {
      if (id === parent.id) return parent;
      if (id === foil.id) return foil;
      return null;
    },
    async issuesByBarcode() {
      return [];
    },
  };
}

function sagaIssue(partial: Partial<GcdIssueRow>): GcdIssueRow {
  return {
    id: "parent",
    seriesId: "9",
    seriesName: "Saga",
    number: "1",
    variant: null,
    variantOf: null,
    title: null,
    coverDate: "March 2012",
    coverYear: 2012,
    onSaleYear: 2012,
    onSaleDate: "2012-03-14",
    price: "2.99 USD",
    pageCount: 44,
    barcode: "70985300001100111",
    publisher: "Image",
    writer: "Brian K. Vaughan",
    artist: "Fiona Staples",
    coverArtist: "Fiona Staples",
    characters: null,
    seriesYear: 2012,
    comicvineIssueId: null,
    metronIssueId: null,
    ...partial,
  };
}

describe("recorded GCD variant", () => {
  it("reads variant_of, variant_name, barcode, price, and on-sale date from the foil issue", () => {
    expect(foil.id).toBe("2514867");
    expect(foil.variant).toBe("Foil Cardstock Cover");
    expect(foil.variantOf).toBe("2513854");
    expect(foil.barcode).toBe("76194137966100121");
    expect(foil.price).toBe("7.99 USD");
    expect(foil.onSaleDate).toBe("2023-04-04");
    expect(foil.pageCount).toBe(68);
    expect(foil.publisher).toBe("DC Comics");
    expect(foil.coverArtist).toBe("Glenn Fabry");
    expect(parent.variantOf ?? null).toBeNull();
    expect(parent.coverUrl).toBe("https://files1.comics.org//img/gcd/covers_by_id/1625/w400/1625206.jpg");
    const hit = gcdHit(foil);
    expect(foil.coverUrl).toBeNull();
    expect(hit.coverUrl).toBeNull();
    expect(hit.covers).toEqual([]);
    expect(gcdHit(parent).coverUrl).toBeNull();
    expect(gcdHit(parent).covers).toEqual([]);
    expect(hit.coverPageUrl).toBe("https://www.comics.org/issue/2514867/cover/4/");
    expect(hit.barcode).toBe("76194137966100121");
    expect(hit.price).toBe("7.99 USD");
    expect(hit.onSaleDate).toBe("2023-04-04");
  });

  it("lists the parent and the foil variant on their own rows", async () => {
    const hits = await searchGcdMatches("Batman: Vengeance of Bane Facsimile Edition #1 2023", "", "query", null, {
      catalog: baneCatalog(),
    });
    expect(hits.map((hit) => hit.id)).toEqual(["2513854", "2514867"]);
    expect(hits[1]).toMatchObject({
      variant: "Foil Cardstock Cover",
      barcode: "76194137966100121",
      price: "7.99 USD",
      onSaleDate: "2023-04-04",
      coverUrl: null,
      coverPageUrl: "https://www.comics.org/issue/2514867/cover/4/",
    });
    const facsimile = series.find((row) => row.id === "198517");
    expect(gcdVariantSiblingIds(facsimile as GcdSeriesRow, "2513854")).toEqual(["2514867"]);
    expect(gcdIssueFamilyKey("1 [Virgin Cover]")).toBe("1");
    expect(gcdIssueFamilyKey("[Foil Cardstock Cover]")).toBe("[nn]");
  });

  it("loads a pasted id or comics.org URL as that variant", async () => {
    expect(parseGcdIssueRef("2513854")).toBe("2513854");
    expect(parseGcdIssueRef("https://www.comics.org/issue/2513854/")).toBe("2513854");
    expect(parseGcdIssueRef("http://comics.org/issue/2514867")).toBe("2514867");
    expect(parseGcdIssueRef("https://www.comics.org/issue/2513854/?format=json")).toBe("2513854");
    expect(parseGcdIssueRef("https://www.comics.org/issue/2513854/cover/4/")).toBeNull();
    expect(parseGcdIssueRef("https://example.com/issue/2513854/")).toBeNull();
    expect(parseGcdIssueRef("0")).toBeNull();

    const hits = await loadGcdIssueHits("https://www.comics.org/issue/2514867/", baneCatalog());
    expect(hits.map((hit) => hit.id)).toEqual(["2514867", "2513854"]);
    expect(hits[0]?.variant).toBe("Foil Cardstock Cover");
    const byId = await loadGcdIssueHits("2513854", baneCatalog());
    expect(byId.map((hit) => hit.id)).toEqual(["2513854", "2514867"]);
  });

  it("prefers the variant whose barcode or name matches the shelf copy", async () => {
    const copy: CoverQuery = {
      series: "Batman: Vengeance of Bane",
      issueNo: "1D",
      issue: "1D",
      coverYear: null,
      releaseYear: 2023,
      releaseDate: "2023-04-04",
      barcode: "76194137966100121",
      variant: null,
      variantDescription: "Facsimile Edition Foil Cardstock Cover",
      publisher: "DC",
    };
    expect(matchingGcdVariant([parent, foil], copy)?.id).toBe("2514867");
    expect(matchingGcdVariant([parent, foil], { ...copy, barcode: null, variantDescription: "Foil Cardstock Cover" })?.id).toBe("2514867");
    expect(matchingGcdVariant([parent, foil], { ...copy, barcode: parent.barcode, variantDescription: "Facsimile Edition 2023" })).toBeNull();

    const decision = await resolveGcdCover(copy, baneCatalog());
    expect(decision).toMatchObject({ status: "matched", via: "gcd", issue: { id: "2514867" } });

    const parentCopy = { ...copy, barcode: parent.barcode, variantDescription: "Facsimile Edition 2023" };
    const regular = await resolveGcdCover(parentCopy, baneCatalog());
    expect(regular).toMatchObject({ status: "matched", via: "gcd", issue: { id: "2513854" } });
  });

  it("prefers a regular variant over its parent when the barcode matches the variant", async () => {
    const base = sagaIssue({ id: "101" });
    const virgin = sagaIssue({
      id: "202",
      variant: "Virgin Cover",
      variantOf: "101",
      barcode: "70985300001100121",
      price: "3.99 USD",
    });
    const catalog: GcdCatalog = {
      async seriesByName() {
        return [
          {
            id: "9",
            name: "Saga",
            yearBegan: 2012,
            yearEnded: null,
            format: "ongoing",
            issues: [
              { id: "101", descriptor: "1" },
              { id: "202", descriptor: "1 [Virgin Cover]" },
            ],
          },
        ];
      },
      async issue(id) {
        if (id === "101") return base;
        if (id === "202") return virgin;
        return null;
      },
      async issuesByBarcode() {
        return [];
      },
    };
    const copy: CoverQuery = {
      series: "Saga",
      issueNo: "1",
      issue: "1",
      coverYear: 2012,
      barcode: "70985300001100121",
      variant: null,
      variantDescription: "Virgin Cover",
      publisher: "Image",
    };
    const decision = await resolveGcdCover(copy, catalog);
    expect(decision).toMatchObject({ status: "matched", via: "gcd", issue: { id: "202" } });

    const byName = await resolveGcdCover({ ...copy, barcode: null }, catalog);
    expect(byName).toMatchObject({ status: "matched", via: "gcd", issue: { id: "202" } });

    const parentHit = await resolveGcdCover({ ...copy, barcode: base.barcode, variantDescription: null }, catalog);
    expect(parentHit).toMatchObject({ status: "matched", via: "gcd", issue: { id: "101" } });
  });
});

describe("GCD link details", () => {
  const hit = gcdHit(foil);
  const detail = gcdDetails(foil);

  it("fills missing fields from the variant issue and stores that issue id as a manual link", () => {
    const update = linkUpdate({
      source: "gcd",
      hit,
      current: { publisher: null, variantDescription: null },
      fieldSources: {},
      manualLink: null,
      detail,
      fillMissing: true,
      cover: null,
    });
    expect(update.data.gcdIssueId).toBe("2514867");
    expect(update.data.gcdIssueId).not.toBe("2513854");
    expect(update.data.variantDescription).toBe("Foil Cardstock Cover");
    expect(update.data.barcode).toBe("76194137966100121");
    expect(update.data.coverPrice).toBe("7.99");
    expect(update.data.pageCount).toBe(68);
    expect(update.data.publisher).toBe("DC Comics");
    expect(update.data.coverArtist).toBe("Glenn Fabry");
    expect(update.data.imprint).toBe("DC Comics");
    expect(readManualLink(update.data.manualLink).gcdIssueId).toBe("2514867");
    expect(update.data.fieldSources).toMatchObject({
      variantDescription: "gcd",
      barcode: "gcd",
      coverPrice: "gcd",
      pageCount: "gcd",
      publisher: "gcd",
      coverArtist: "gcd",
    });
  });

  it("overwrites filled-in values and leaves hand-edited fields alone", () => {
    const update = linkUpdate({
      source: "gcd",
      hit,
      current: {
        barcode: "OLD",
        coverPrice: "3.99",
        publisher: "Mine",
        variantDescription: "My cover",
        pageCount: 20,
      },
      fieldSources: { variantDescription: "user", publisher: "user" },
      manualLink: null,
      detail,
      fillMissing: true,
      overwrite: true,
      cover: null,
    });
    expect(update.data.barcode).toBe("76194137966100121");
    expect(update.data.coverPrice).toBe("7.99");
    expect(update.data.pageCount).toBe(68);
    expect(update.data.variantDescription).toBeUndefined();
    expect(update.data.publisher).toBeUndefined();
    expect(update.data.fieldSources).toMatchObject({
      variantDescription: "user",
      publisher: "user",
      barcode: "gcd",
      coverPrice: "gcd",
      pageCount: "gcd",
    });
    expect(readManualLink(update.data.manualLink).gcdIssueId).toBe("2514867");
  });

  it("does not fill details when both checkboxes are off", () => {
    const update = linkUpdate({
      source: "gcd",
      hit,
      current: { barcode: "OLD", variantDescription: null, publisher: null },
      fieldSources: {},
      manualLink: null,
      detail,
      fillMissing: false,
      cover: null,
    });
    expect(update.data.gcdIssueId).toBe("2514867");
    expect(update.data.barcode).toBeUndefined();
    expect(update.data.variantDescription).toBeUndefined();
    expect(update.data.publisher).toBeUndefined();
    expect(readManualLink(update.data.manualLink).gcdIssueId).toBe("2514867");
  });
});
