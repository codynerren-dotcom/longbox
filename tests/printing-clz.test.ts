import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GcdCatalog, GcdIssueRow } from "@/lib/catalog/gcd";
import { backfillCovers } from "@/lib/covers/backfill";
import {
  detectEdition,
  printingArtistHint,
  printingNumberFromBarcode,
  printingNumberFromText,
  scoreCandidate,
  stripIssueVariant,
  suspectMatchReason,
} from "@/lib/covers/edition";
import { resolveGcdCover } from "@/lib/covers/gcd-match";
import { resolveCover } from "@/lib/covers/match";
import type { CoverLookup, CoverQuery, CoverRecord, MetronIssueHit } from "@/lib/covers/types";

const avengers: CoverQuery = {
  series: "Avengers, Vol. 8",
  issueNo: "7E",
  issue: "7E",
  coverYear: 2018,
  releaseYear: 2018,
  releaseDate: "2018-10-10",
  barcode: "75960608857700712",
  variant: null,
  variantDescription: "Second Printing",
  format: null,
  publisher: "Marvel",
  seriesYear: 2018,
};

function copy(overrides: Partial<CoverQuery> = {}): CoverQuery {
  return { ...avengers, ...overrides };
}

function parentIssue(overrides: Partial<MetronIssueHit> = {}): MetronIssueHit {
  return {
    id: "av7",
    seriesId: "8",
    seriesName: "Avengers",
    number: "7",
    coverYear: 2018,
    releaseYear: 2018,
    seriesYear: 2018,
    publisher: "Marvel",
    imageUrl: "https://static.metron.cloud/main.jpg",
    label: null,
    variant: null,
    upc: "75960608857700711",
    covers: [
      { label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" },
      { label: "2nd Printing", imageUrl: "https://static.metron.cloud/second.jpg" },
    ],
    ...overrides,
  };
}

function lookup(overrides: Partial<CoverLookup> = {}): CoverLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async issuesByUpc() {
      return [];
    },
    async issuesByUpcPrefix() {
      return [];
    },
    async searchSeries(name) {
      calls.push(name);
      return [];
    },
    async issuesForSeries() {
      return [];
    },
    ...overrides,
  };
}

function record(query: CoverQuery, overrides: Partial<CoverRecord> = {}): CoverRecord {
  return { id: "comic-1", coverFile: null, coverStatus: null, metronIssueId: null, ...query, ...overrides };
}

describe("later printing detection", () => {
  it("reads the printing from the description and the UPC add-on, and strips variant letters", () => {
    const second = detectEdition(avengers);
    expect(second.kind).toBe("printing");
    expect(second.printing).toBe(2);
    expect(second.issueNo).toBe("7");
    expect(stripIssueVariant("7E")).toEqual({ number: "7", letter: "E" });
    expect(stripIssueVariant("1AX")).toEqual({ number: "1", letter: "AX" });
    expect(stripIssueVariant("2G")).toEqual({ number: "2", letter: "G" });
    expect(stripIssueVariant("1AH")).toEqual({ number: "1", letter: "AH" });
    expect(second.searchNames.some((name) => /facsimile/i.test(name))).toBe(false);
    expect(printingNumberFromBarcode("75960608857700712")).toBe(2);
    expect(printingNumberFromBarcode("70985303032400114")).toBe(4);
    expect(printingArtistHint("2nd Printing Variant Travel Foreman Cover")).toBe("Travel Foreman");

    expect(detectEdition({ ...avengers, variantDescription: "First Printing" }).kind).toBe("regular");
    expect(detectEdition({ ...avengers, variantDescription: "1st printing", barcode: "75960608857700711" }).kind).toBe("regular");
    expect(detectEdition({ ...avengers, variantDescription: null, barcode: "75960608857700711" }).printing).toBeNull();

    const addonOnly = detectEdition({ ...avengers, variantDescription: null, issueNo: "1", barcode: "75960609420200112" });
    expect(addonOnly.kind).toBe("printing");
    expect(addonOnly.printing).toBe(2);

    const described = detectEdition({
      ...avengers,
      series: "The Department of Truth",
      issueNo: "1AH",
      variantDescription: "4th Printing",
      barcode: "70985303032400112",
      publisher: "Image",
    });
    expect(described.printing).toBe(4);
    expect(described.issueNo).toBe("1");
    expect(printingNumberFromText("4th Printing")).toBe(4);
    expect(printingNumberFromText("First Printing")).toBe(1);
  });

  it("scores the volume-stripped series and refuses a different printing", () => {
    const same = scoreCandidate(avengers, {
      seriesName: "Avengers",
      issueNo: "7",
      variant: null,
      coverYear: 2018,
      releaseYear: 2018,
      seriesYear: 2018,
      upc: null,
      publisher: "Marvel",
    });
    expect(same.auto).toBe(true);
    expect(same.score).toBeGreaterThanOrEqual(75);

    const third = scoreCandidate(avengers, {
      seriesName: "Avengers",
      issueNo: "7",
      variant: "3rd Printing",
      coverYear: 2018,
      releaseYear: 2018,
      seriesYear: 2018,
      upc: null,
      publisher: "Marvel",
    });
    expect(third.auto).toBe(false);
    expect(third.blocked).toMatch(/3rd printing/);
  });
});

describe("later printing covers", () => {
  it("selects the 2nd printing cover from the UPC and does not search a facsimile series", async () => {
    const client = lookup({
      async issuesByUpc() {
        return [parentIssue()];
      },
      async searchSeries(name) {
        client.calls.push(`series:${name}`);
        return [];
      },
    });
    const decision = await resolveCover(avengers, client);
    expect(decision).toMatchObject({
      status: "matched",
      via: "barcode",
      issue: { id: "av7", imageUrl: "https://static.metron.cloud/second.jpg" },
      coverReview: null,
    });
    expect(decision.status === "matched" ? decision.issue.imageUrl : "").not.toContain("main.jpg");
    expect(client.calls.join(" ")).not.toMatch(/facsimile/i);
  });

  it("picks the Travel Foreman 2nd printing cover for Black Cat", async () => {
    const blackCat = copy({
      series: "Black Cat, Vol. 1",
      issueNo: "1AX",
      issue: "1AX",
      variantDescription: "2nd Printing Variant Travel Foreman Cover",
      barcode: "75960609420200112",
      releaseYear: 2019,
      coverYear: 2019,
      releaseDate: "2019-06-05",
      seriesYear: 2019,
    });
    const decision = await resolveCover(
      blackCat,
      lookup({
        async issuesByUpc() {
          return [
            parentIssue({
              id: "bc1",
              seriesName: "Black Cat",
              number: "1",
              coverYear: 2019,
              releaseYear: 2019,
              seriesYear: 2019,
              upc: "75960609420200111",
              covers: [
                { label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" },
                { label: "2nd Printing", imageUrl: "https://static.metron.cloud/plain-second.jpg" },
                { label: "2nd Printing Variant Travel Foreman Cover", imageUrl: "https://static.metron.cloud/foreman.jpg" },
              ],
            }),
          ];
        },
      }),
    );
    expect(decision).toMatchObject({
      status: "matched",
      issue: { imageUrl: "https://static.metron.cloud/foreman.jpg" },
      coverReview: null,
    });
  });

  it("keeps the issue link and leaves the cover for review when only the 1st-print cover exists", async () => {
    const decision = await resolveCover(
      avengers,
      lookup({
        async issuesByUpc() {
          return [parentIssue({ covers: [{ label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" }] })];
        },
      }),
    );
    expect(decision.status).toBe("matched");
    if (decision.status !== "matched") return;
    expect(decision.issue.imageUrl).toBeNull();
    expect(decision.coverReview).toMatch(/1st-print|printing cover/);
    expect(decision.issue.imageUrl ?? "").not.toContain("main.jpg");
  });

  it("uses a separate 2nd printing issue and ignores a 3rd printing issue", async () => {
    const carnage = copy({
      series: "Carnage, Vol. 3",
      issueNo: "2G",
      issue: "2G",
      variantDescription: "2nd Printing",
      barcode: "75960620243000212",
      releaseYear: 2023,
      coverYear: 2023,
      seriesYear: 2022,
    });
    const separate = await resolveCover(
      carnage,
      lookup({
        async issuesByUpc() {
          return [
            parentIssue({
              id: "c2",
              seriesName: "Carnage",
              number: "2",
              coverYear: 2023,
              releaseYear: 2023,
              seriesYear: 2022,
              variant: "2nd Printing",
              label: "2nd Printing",
              imageUrl: "https://static.metron.cloud/carnage-second.jpg",
              upc: "75960620243000212",
              covers: [{ label: "Cover", imageUrl: "https://static.metron.cloud/carnage-second.jpg" }],
            }),
          ];
        },
      }),
    );
    expect(separate).toMatchObject({
      status: "matched",
      issue: { id: "c2", imageUrl: "https://static.metron.cloud/carnage-second.jpg" },
    });
    expect(separate.status === "matched" ? separate.coverReview : "review").toBeFalsy();

    const thirdOnly = await resolveCover(
      carnage,
      lookup({
        async issuesByUpc() {
          return [
            parentIssue({
              id: "c2-third",
              seriesName: "Carnage",
              number: "2",
              coverYear: 2023,
              releaseYear: 2023,
              seriesYear: 2022,
              variant: "3rd Printing",
              label: "3rd Printing",
              imageUrl: "https://static.metron.cloud/carnage-third.jpg",
            }),
          ];
        },
      }),
    );
    expect(thirdOnly.status).toBe("unmatched");
  });

  it("finds Avengers on the series name after the volume is stripped", async () => {
    const client = lookup({
      async searchSeries(name) {
        client.calls.push(name);
        if (name === "Avengers") {
          return [{ id: "8", name: "Avengers", yearBegan: 2018, yearEnd: null, publisher: "Marvel" }];
        }
        return [];
      },
      async issuesForSeries() {
        return [parentIssue({ upc: null })];
      },
    });
    const decision = await resolveCover(copy({ barcode: null }), client);
    expect(decision).toMatchObject({ status: "matched", issue: { imageUrl: "https://static.metron.cloud/second.jpg" } });
    expect(client.calls).toContain("Avengers");
    expect(client.calls.some((name) => /facsimile/i.test(name))).toBe(false);
  });
});

describe("later printing review", () => {
  it("lists an unconfirmed printing and drops it once that printing cover is confirmed", () => {
    expect(suspectMatchReason({ ...avengers, metronIssueId: "av7" })).toMatch(/2nd printing cover has not been confirmed/);
    expect(suspectMatchReason({ ...avengers, metronIssueId: "av7", catalogPrinting: 2 })).toBeNull();
    expect(suspectMatchReason({ ...avengers, metronIssueId: "av7", catalogPrinting: 4 })).toMatch(/2nd printing/);
    expect(
      suspectMatchReason({
        ...avengers,
        variantDescription: "First Printing",
        barcode: "75960608857700711",
        metronIssueId: "av7",
      }),
    ).toBeNull();
  });

  it("saves the printing cover and leaves the 1st-print image off when that cover is missing", async () => {
    const saved: string[] = [];
    const marked: Array<{ coverFile: string | null; coverUrl?: string | null; coverNote?: string | null; printing?: number | null }> = [];
    const missing = await backfillCovers({
      comics: [record(avengers)],
      lookup: lookup({
        async issuesByUpc() {
          return [parentIssue({ covers: [{ label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" }] })];
        },
      }),
      fileExists: () => false,
      saveImage: async (issue) => {
        saved.push(issue.imageUrl ?? "");
        return "metron-av7.jpg";
      },
      loadDetail: async () => ({
        id: "av7",
        seriesId: "8",
        seriesName: "Avengers",
        number: "7",
        imageUrl: "https://static.metron.cloud/main.jpg",
        coverDate: "October 2018",
        coverYear: 2018,
        releaseDate: new Date("2018-10-10T12:00:00.000Z"),
        title: null,
        storyArc: null,
        plot: null,
        pageCount: null,
        coverPrice: null,
        barcode: null,
        writer: null,
        artist: null,
        coverArtist: null,
        characters: null,
        teams: null,
        imprint: "Marvel",
        seriesYear: 2018,
        seriesVolume: 8,
        metronIssueUrl: null,
        metronSeriesUrl: null,
        comicvineIssueId: null,
        comicvineSeriesId: null,
        gcdIssueId: null,
        gcdSeriesId: null,
        covers: [{ label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" }],
      }),
      markMatched: async (_id, update) => {
        marked.push(update);
      },
      markUnmatched: async () => {
        throw new Error("the issue should stay linked");
      },
    });
    expect(missing.matched).toBe(1);
    expect(saved).toEqual([]);
    expect(marked[0]?.coverFile).toBeNull();
    expect(marked[0]?.printing).toBeNull();
    expect(marked[0]?.coverNote).toMatch(/Needs review/);
    expect(marked[0]?.coverNote).toMatch(/1st-print|printing cover/);

    saved.length = 0;
    marked.length = 0;
    const found = await backfillCovers({
      comics: [record(avengers)],
      lookup: lookup({
        async issuesByUpc() {
          return [parentIssue()];
        },
      }),
      fileExists: () => false,
      saveImage: async (issue) => {
        saved.push(issue.imageUrl ?? "");
        return "metron-second.jpg";
      },
      loadDetail: async () => ({
        id: "av7",
        seriesId: "8",
        seriesName: "Avengers",
        number: "7",
        imageUrl: "https://static.metron.cloud/main.jpg",
        coverDate: null,
        coverYear: 2018,
        releaseDate: null,
        title: null,
        storyArc: null,
        plot: null,
        pageCount: null,
        coverPrice: null,
        barcode: null,
        writer: null,
        artist: null,
        coverArtist: null,
        characters: null,
        teams: null,
        imprint: null,
        seriesYear: 2018,
        seriesVolume: null,
        metronIssueUrl: null,
        metronSeriesUrl: null,
        comicvineIssueId: null,
        comicvineSeriesId: null,
        gcdIssueId: null,
        gcdSeriesId: null,
        covers: [{ label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" }],
      }),
      markMatched: async (_id, update) => {
        marked.push(update);
      },
      markUnmatched: async () => {
        throw new Error("should match");
      },
    });
    expect(found.matched).toBe(1);
    expect(saved).toEqual(["https://static.metron.cloud/second.jpg"]);
    expect(marked[0]).toMatchObject({ coverFile: "metron-second.jpg", printing: 2 });

    marked.length = 0;
    const kept = await backfillCovers({
      comics: [record(avengers, { coverFile: "metron-old.jpg" })],
      lookup: lookup({
        async issuesByUpc() {
          return [parentIssue({ covers: [{ label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" }] })];
        },
      }),
      fileExists: () => false,
      saveImage: async () => {
        throw new Error("the 1st-print file should stay");
      },
      loadDetail: async () => ({
        id: "av7",
        seriesId: "8",
        seriesName: "Avengers",
        number: "7",
        imageUrl: "https://static.metron.cloud/main.jpg",
        coverDate: null,
        coverYear: 2018,
        releaseDate: null,
        title: null,
        storyArc: null,
        plot: null,
        pageCount: null,
        coverPrice: null,
        barcode: null,
        writer: null,
        artist: null,
        coverArtist: null,
        characters: null,
        teams: null,
        imprint: null,
        seriesYear: 2018,
        seriesVolume: null,
        metronIssueUrl: null,
        metronSeriesUrl: null,
        comicvineIssueId: null,
        comicvineSeriesId: null,
        gcdIssueId: null,
        gcdSeriesId: null,
        covers: [{ label: "Cover", imageUrl: "https://static.metron.cloud/main.jpg" }],
      }),
      markMatched: async (_id, update) => {
        marked.push(update);
      },
      markUnmatched: async () => {
        throw new Error("the issue should stay linked");
      },
    });
    expect(kept.matched).toBe(1);
    expect(marked[0]?.coverFile).toBe("metron-old.jpg");
    expect(marked[0]?.coverUrl).toBe("/covers/files/metron-old.jpg");
    expect(marked[0]?.coverNote).toMatch(/Needs review/);
    expect(marked[0]?.printing).toBeNull();
  });
});

describe("GCD later printings", () => {
  function gcdRow(overrides: Partial<GcdIssueRow> = {}): GcdIssueRow {
    return {
      id: "gcd-7",
      seriesId: "gcd-av",
      seriesName: "Avengers",
      number: "7",
      variant: null,
      title: null,
      coverDate: "October 2018",
      coverYear: 2018,
      onSaleYear: 2018,
      onSaleDate: "2018-10-10",
      price: "3.99 USD",
      pageCount: 32,
      barcode: "75960608857700711",
      publisher: "Marvel",
      writer: null,
      artist: null,
      coverArtist: null,
      characters: null,
      seriesYear: 2018,
      comicvineIssueId: null,
      metronIssueId: null,
      ...overrides,
    };
  }

  it("confirms a Second Printing variant and leaves a main-only issue for review", async () => {
    const confirmed = await resolveGcdCover(copy({ barcode: null }), {
      async issuesByBarcode() {
        return [];
      },
      async seriesByName(name) {
        if (name !== "Avengers") return [];
        return [
          {
            id: "gcd-av",
            name: "Avengers",
            yearBegan: 2018,
            yearEnded: null,
            format: "series",
            issues: [
              { id: "gcd-7", descriptor: "7" },
              { id: "gcd-7b", descriptor: "7 [2nd Printing]" },
            ],
          },
        ];
      },
      async issue(id) {
        if (id === "gcd-7b") return gcdRow({ id, variant: "Second Printing", number: "7 [2nd Printing]", barcode: avengers.barcode });
        if (id === "gcd-7") return gcdRow();
        return null;
      },
    } satisfies GcdCatalog);
    expect(confirmed).toMatchObject({ status: "matched", via: "gcd", issue: { id: "gcd-7b" } });
    expect(confirmed.status === "matched" ? confirmed.coverReview : "review").toBeFalsy();

    const review = await resolveGcdCover(copy({ barcode: null }), {
      async issuesByBarcode() {
        return [];
      },
      async seriesByName(name) {
        if (name !== "Avengers") return [];
        return [
          {
            id: "gcd-av",
            name: "Avengers",
            yearBegan: 2018,
            yearEnded: null,
            format: "series",
            issues: [{ id: "gcd-7", descriptor: "7" }],
          },
        ];
      },
      async issue(id) {
        return id === "gcd-7" ? gcdRow() : null;
      },
    } satisfies GcdCatalog);
    expect(review.status).toBe("matched");
    if (review.status !== "matched") return;
    expect(review.issue.imageUrl).toBeNull();
    expect(review.coverReview).toMatch(/1st-print|printing cover/);
  });
});

describe("later printing surfaces", () => {
  it("keeps later printings in the suspect re-match and the stripped Match query", () => {
    const years = readFileSync("src/lib/covers/facsimile-years.ts", "utf8");
    const rematch = readFileSync("src/lib/covers/facsimile-rematch.ts", "utf8");
    const page = readFileSync("src/app/covers/page.tsx", "utf8");
    const issue = readFileSync("src/app/issues/[id]/page.tsx", "utf8");
    expect(years).toContain('export const FACSIMILE_REMATCH_KEY = "edition-rematch-v2"');
    expect(rematch).toContain("readPrintingCovers");
    expect(rematch).toContain("catalogPrinting");
    expect(rematch).toContain("This link was chosen by hand. Unlink it first.");
    expect(page).toContain("catalogPrinting");
    expect(page).toContain("A later printing stays on the same issue.");
    expect(page).not.toContain("later printing, anniversary");
    expect(page).not.toContain("\u2014");
    expect(issue).toContain('edition.kind === "printing"');
    const truth = detectEdition({
      series: "The Department of Truth",
      issueNo: "1AH",
      variantDescription: "4th Printing",
      barcode: "70985303032400114",
      publisher: "Image",
      coverYear: 2020,
      releaseYear: 2020,
    });
    expect(truth.issueNo).toBe("1");
    expect(truth.printing).toBe(4);
  });
});
