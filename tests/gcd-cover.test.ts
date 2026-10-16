import { describe, expect, it, vi } from "vitest";
import { findAlternateCover, pickAlternateCover, type AlternateCoverSearch } from "@/lib/catalog/gcd-cover";
import { gcdCoverScan, parseGcdIssue, type GcdCatalog, type GcdIssueRow, type GcdSeriesRow } from "@/lib/catalog/gcd";
import { linkUpdate } from "@/lib/catalog/link-plan";
import { readManualLink, shouldSaveCatalogCover, withUserCover } from "@/lib/catalog/manual-link";
import { defaultUseCover, exactBarcodeMatch, fullSizeCoverUrl, GCD_COVER_MISSED, isGcdScanHost } from "@/lib/catalog/match-row";
import type { MatchHit } from "@/lib/catalog/match-hits";
import { imagePaceName } from "@/lib/catalog/rate-limit";
import { gcdDetails, gcdHit, gcdMatchIssueIds, orderGcdMatchHits, searchGcdMatches } from "@/lib/covers/gcd-match";
import { coverContentType, coverFilename, downloadCover } from "@/lib/covers/files";
import { MetronBudgetError } from "@/lib/covers/types";

function coverRow(id: string, variant: string, barcode: string, variantOf: string | null): GcdIssueRow {
  return {
    id,
    seriesId: "special",
    seriesName: "I Hate Fairyland: I Hate Image Special Edition",
    number: variantOf ? "[nn]" : "1",
    variant,
    variantOf,
    title: null,
    coverDate: "2017",
    coverYear: 2017,
    onSaleYear: 2017,
    onSaleDate: "2017-04-05",
    price: "3.99 USD",
    pageCount: 32,
    barcode,
    publisher: "Image",
    writer: null,
    artist: null,
    coverArtist: null,
    characters: null,
    seriesYear: 2017,
    comicvineIssueId: null,
    metronIssueId: null,
    coverUrl: `https://files1.comics.org/img/gcd/covers_by_id/1/w400/${id}.jpg`,
  };
}

const PARENT = "https://files1.comics.org/img/gcd/covers_by_id/10/w400/10.jpg";
const VARIANT = "https://files1.comics.org/img/gcd/covers_by_id/11/w400/11.jpg";

function issue(id: string, cover: string, variantOf: string | null = null) {
  return parseGcdIssue({
    api_url: `https://www.comics.org/api/issue/${id}/`,
    series: "https://www.comics.org/api/series/9/",
    series_name: "Saga (2012 series)",
    number: "1",
    variant_name: variantOf ? "Virgin Cover" : null,
    variant_of: variantOf ? `https://www.comics.org/api/issue/${variantOf}/` : null,
    cover,
  });
}

describe("GCD cover scans", () => {
  it("puts the issue cover on the match row and leaves automatic backfill without an image", () => {
    expect(gcdCoverScan("")).toBeNull();
    expect(gcdCoverScan("http://files1.comics.org/img/a.jpg")).toBe("https://files1.comics.org/img/a.jpg");
    const parent = issue("10", PARENT);
    const variant = issue("11", VARIANT, "10");
    expect(parent?.coverUrl).toBe(PARENT);
    expect(variant?.coverUrl).toBe(VARIANT);
    expect(variant?.coverUrl).not.toBe(parent?.coverUrl);
    expect(gcdDetails(parent!).imageUrl).toBeNull();
    expect(gcdHit(variant!).coverUrl).toBeNull();
    expect(gcdHit(variant!).covers).toEqual([]);
    expect(gcdHit(issue("12", "")!).coverUrl).toBeNull();
    expect(gcdHit(issue("12", "")!).covers).toEqual([]);
  });

  it("saves a variant scan and refuses to replace a photo unless replace existing is set", () => {
    expect(shouldSaveCatalogCover({ useCover: true, userCover: false, replaceExisting: false })).toBe(true);
    expect(shouldSaveCatalogCover({ useCover: false, userCover: false, replaceExisting: false })).toBe(false);
    expect(shouldSaveCatalogCover({ useCover: true, userCover: true, replaceExisting: false })).toBe(false);
    expect(shouldSaveCatalogCover({ useCover: true, userCover: true, replaceExisting: true })).toBe(true);

    const variant = gcdHit(issue("11", VARIANT, "10")!);
    const saved = linkUpdate({
      source: "gcd",
      hit: variant,
      current: {},
      fieldSources: {},
      manualLink: null,
      detail: null,
      fillMissing: false,
      cover: { file: "gcd-11.jpg", url: "/covers/files/gcd-11.jpg", imageUrl: VARIANT },
    });
    expect(saved.data.coverFile).toBe("gcd-11.jpg");
    expect(saved.data.coverUrl).toBe("/covers/files/gcd-11.jpg");
    expect(saved.data.coverStatus).toBe("matched");
    expect(saved.data.coverNote).toBeNull();
    expect(readManualLink(saved.data.manualLink)).toMatchObject({
      gcdIssueId: "11",
      coverSource: "gcd",
      coverImageUrl: VARIANT,
      userCover: false,
    });

    const photo = linkUpdate({
      source: "gcd",
      hit: variant,
      current: {},
      fieldSources: {},
      manualLink: withUserCover(null, "user-cmv777zqb000sqxabc70ckhaw-original.jpg"),
      detail: null,
      fillMissing: false,
      cover: null,
    });
    expect(photo.data.coverFile).toBeUndefined();
    expect(photo.data.coverUrl).toBeUndefined();
    expect(photo.data.coverStatus).toBeUndefined();
    expect(readManualLink(photo.data.manualLink).userCover).toBe(true);
    expect(readManualLink(photo.data.manualLink).coverSource).toBeNull();
  });

  it("lists every cover of a one-shot and sorts the exact add-on match first", async () => {
    const shelf = "70985302446000111";
    expect(exactBarcodeMatch(shelf, "70985302446000111")).toBe(true);
    expect(exactBarcodeMatch(shelf, "70985302446000131")).toBe(false);
    expect(exactBarcodeMatch(shelf, "709853024460")).toBe(false);
    expect(fullSizeCoverUrl("https://files1.comics.org/img/gcd/covers_by_id/1/w400/1.jpg")).toBeNull();
    expect(fullSizeCoverUrl("https://static.metron.cloud/media/issue/batman-1.jpg")).toBe("https://static.metron.cloud/media/issue/batman-1.jpg");

    const special: GcdSeriesRow = {
      id: "special",
      name: "I Hate Fairyland: I Hate Image Special Edition",
      yearBegan: 2017,
      yearEnded: 2017,
      format: "one-shot",
      issues: [
        { id: "c", descriptor: "1 [Cover C - Walking Dead Tribute]" },
        { id: "a", descriptor: "[Cover A]" },
        { id: "b", descriptor: "[Cover B]" },
        { id: "d", descriptor: "[Cover D - Walking Dead Tribute Black and White]" },
      ],
    };
    expect(gcdMatchIssueIds(special, "1", 2017)).toEqual(["c", "a", "b", "d"]);
    const ongoing: GcdSeriesRow = {
      ...special,
      id: "ongoing",
      format: "ongoing series",
      issues: [
        { id: "1a", descriptor: "1 [Cover A]" },
        { id: "1b", descriptor: "1 [Cover B]" },
        { id: "2", descriptor: "2" },
      ],
    };
    expect(gcdMatchIssueIds(ongoing, "1", 2015)).toEqual(["1a", "1b"]);

    const rows: Record<string, GcdIssueRow> = {
      c: coverRow("c", "Cover C - Walking Dead Tribute", "70985302446000131", "a"),
      a: coverRow("a", "Cover A", shelf, null),
      b: coverRow("b", "Cover B", "70985302446000121", "a"),
      d: coverRow("d", "Cover D - Walking Dead Tribute Black and White", "70985302446000141", "a"),
    };
    const fetched: string[] = [];
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        return /i hate image special/i.test(name) ? [special] : [];
      },
      async issue(id) {
        fetched.push(id);
        return rows[id] ?? null;
      },
      async issuesByBarcode() {
        return [];
      },
    };
    const hits = await searchGcdMatches("I Hate Fairyland: I Hate Image Special Edition #1 2017", shelf, "query", null, { catalog });
    expect(fetched.sort()).toEqual(["a", "b", "c", "d"]);
    expect(hits.map((hit) => hit.id)).toEqual(["a", "c", "b", "d"]);
    expect(hits[0]?.barcode).toBe(shelf);
    expect(orderGcdMatchHits(hits, shelf)[0]?.id).toBe("a");
    expect(hits.filter((hit) => hit.variant === "Cover C - Walking Dead Tribute")).toHaveLength(1);
  });

  it("serves a gcd cover file and paces image hosts apart from the API windows", () => {
    expect(coverFilename("11", "jpeg", "gcd")).toBe("gcd-11.jpg");
    expect(coverContentType("gcd-11.jpg")).toBe("image/jpeg");
    expect(coverContentType("gcd-11-ab12cd34.png")).toBe("image/png");
    expect(imagePaceName("files1.comics.org")).toBe("gcd-images");
    expect(imagePaceName("comicvine.gamespot.com")).toBe("comicvine-images");
    expect(imagePaceName("static.metron.cloud")).toBe("covers");
    expect(imagePaceName("www.comics.org")).toBe("covers");
  });
});

const BARCODE = "76194137888600134";
const METRON_REGULAR = "https://static.metron.cloud/media/issue/batman-1.jpg";
const METRON_VARIANT = "https://static.metron.cloud/media/issue/batman-1-mcfarlane.jpg";
const CV_COVER = "https://comicvine.gamespot.com/a/uploads/scale_large/batman-1.jpg";

function hit(partial: Partial<MatchHit> & Pick<MatchHit, "source" | "id" | "coverUrl">): MatchHit {
  return {
    seriesId: "1",
    series: "Batman",
    issueNo: "1",
    variant: null,
    coverDate: "December 2022",
    publisher: "DC",
    covers: partial.coverUrl ? [{ label: "Cover", imageUrl: partial.coverUrl }] : [],
    ...partial,
  };
}

describe("GCD covers from another catalog", () => {
  const wanted = {
    series: "Batman",
    issueNo: "1",
    variant: "Todd McFarlane Variant Cover",
    barcode: BARCODE,
    year: 2022,
  };

  it("leaves Use this cover off for a GCD row and refuses to fetch files1", async () => {
    expect(defaultUseCover("gcd", true, false)).toBe(false);
    expect(defaultUseCover("metron", true, false)).toBe(true);
    expect(defaultUseCover("comicvine", true, true)).toBe(false);
    expect(isGcdScanHost("https://files1.comics.org//img/gcd/covers_by_id/1657/w400/1657357.jpg")).toBe(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not fetch"));
    await expect(
      downloadCover("https://files1.comics.org//img/gcd/covers_by_id/1657/w400/1657357.jpg", "2567072", undefined, { force: true, prefix: "gcd" }),
    ).rejects.toThrow(GCD_COVER_MISSED);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("prefers the exact variant cover from a barcode match", () => {
    const metron = hit({
      source: "metron",
      id: "88",
      coverUrl: METRON_REGULAR,
      variant: "Todd McFarlane Variant Cover",
      barcode: BARCODE,
      covers: [
        { label: "Cover", imageUrl: METRON_REGULAR },
        { label: "Todd McFarlane Variant Cover", imageUrl: METRON_VARIANT },
      ],
    });
    const vine = hit({
      source: "comicvine",
      id: "400",
      coverUrl: CV_COVER,
      variant: "Cover A",
      barcode: "76194137888600111",
    });
    const picked = pickAlternateCover(wanted, [
      { ...vine, via: "barcode" },
      { ...metron, via: "barcode" },
    ]);
    expect(picked?.imageUrl).toBe(METRON_VARIANT);
    expect(picked?.source).toBe("metron");
    expect(picked?.issueId).toBe("88");
  });

  it("uses a name and number match when the barcode search has no cover, and ignores a files1 image", async () => {
    const calls: string[] = [];
    const search: AlternateCoverSearch = {
      async metronBarcode() {
        calls.push("metron-barcode");
        return [hit({ source: "metron", id: "1", coverUrl: "https://files1.comics.org/img/a.jpg", barcode: BARCODE })];
      },
      async comicVineBarcode() {
        calls.push("cv-barcode");
        return [];
      },
      async metronQuery() {
        calls.push("metron-name");
        return [];
      },
      async comicVineQuery(query) {
        calls.push(`cv-name:${query}`);
        return [hit({ source: "comicvine", id: "400", coverUrl: CV_COVER, variant: "Todd McFarlane Variant Cover" })];
      },
    };
    const picked = await findAlternateCover(wanted, search);
    expect(calls).toEqual(["metron-barcode", "cv-barcode", "metron-name", "cv-name:Batman #1 2022"]);
    expect(picked).toMatchObject({ source: "comicvine", issueId: "400", imageUrl: CV_COVER });
  });

  it("stops after a barcode hit whose cover is the exact variant", async () => {
    const calls: string[] = [];
    const search: AlternateCoverSearch = {
      async metronBarcode() {
        calls.push("metron-barcode");
        return [
          hit({
            source: "metron",
            id: "88",
            coverUrl: METRON_VARIANT,
            variant: "Todd McFarlane Variant Cover",
            barcode: BARCODE,
            covers: [{ label: "Todd McFarlane Variant Cover", imageUrl: METRON_VARIANT }],
          }),
        ];
      },
      async comicVineBarcode() {
        calls.push("cv-barcode");
        return [];
      },
      async metronQuery() {
        calls.push("metron-name");
        return [];
      },
      comicVineQuery: null,
    };
    const picked = await findAlternateCover(wanted, search);
    expect(calls).toEqual(["metron-barcode", "cv-barcode"]);
    expect(picked?.imageUrl).toBe(METRON_VARIANT);
  });

  it("keeps a GCD accept going when Metron's circuit is open", async () => {
    const calls: string[] = [];
    const search: AlternateCoverSearch = {
      async metronBarcode() {
        calls.push("metron-barcode");
        throw new MetronBudgetError("Metron is paused after connect failures.", {
          budget: "Metron connect",
          count: 3,
          resumeAt: Date.now() + 60_000,
        });
      },
      async metronQuery() {
        calls.push("metron-name");
        throw new MetronBudgetError("Metron is paused after connect failures.", {
          budget: "Metron connect",
          count: 3,
          resumeAt: Date.now() + 60_000,
        });
      },
      async comicVineBarcode() {
        calls.push("cv-barcode");
        return [];
      },
      async comicVineQuery() {
        calls.push("cv-name");
        return [hit({ source: "comicvine", id: "400", coverUrl: CV_COVER, variant: "Todd McFarlane Variant Cover" })];
      },
    };
    const picked = await findAlternateCover(wanted, search);
    expect(calls).toEqual(["metron-barcode", "cv-barcode", "metron-name", "cv-name"]);
    expect(picked).toMatchObject({ source: "comicvine", issueId: "400", imageUrl: CV_COVER });
  });

  it("reports no other cover when every candidate is empty", async () => {
    const picked = await findAlternateCover(wanted, {
      metronBarcode: async () => [],
      metronQuery: async () => [],
      comicVineBarcode: async () => [],
      comicVineQuery: async () => [],
    });
    expect(picked).toBeNull();
    expect(GCD_COVER_MISSED).toBe("GCD doesn't allow cover downloads; no other source had this cover. Use Upload cover or Take photo.");
  });
});
