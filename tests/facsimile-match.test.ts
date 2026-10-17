import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GcdBudgetError, createGcdCatalog, gcdByBarcode, parseGcdIssue, parseGcdSeries, resetGcdBudget, type GcdCatalog, type GcdIssueRow } from "@/lib/catalog/gcd";
import { backfillCovers } from "@/lib/covers/backfill";
import { detectEdition, scoreCandidate, suspectMatchReason } from "@/lib/covers/edition";
import { fieldCredit, planEnrichment, type MetronDetails } from "@/lib/covers/enrich";
import { gcdDetails, gcdHit, resolveGcdCover } from "@/lib/covers/gcd-match";
import { resolveCover } from "@/lib/covers/match";
import type { CoverLookup, CoverQuery, CoverRecord, MetronIssueHit, MetronSeriesHit } from "@/lib/covers/types";

const spider: CoverQuery = {
  series: "The Amazing Spider-Man",
  issueNo: "1",
  issue: "1",
  coverYear: 1963,
  releaseYear: 2022,
  barcode: null,
  variant: null,
  variantDescription: "Facsimile Edition",
  format: null,
  publisher: "Marvel",
  coverPrice: "4.99",
};

function hit(overrides: Partial<MetronIssueHit> = {}): MetronIssueHit {
  return {
    id: "10",
    seriesId: "1",
    seriesName: "The Amazing Spider-Man",
    number: "1",
    coverYear: 1963,
    imageUrl: "https://static.metron.cloud/asm-1.jpg",
    label: null,
    releaseYear: 1963,
    seriesYear: 1963,
    publisher: "Marvel",
    ...overrides,
  };
}

function seriesHit(overrides: Partial<MetronSeriesHit> = {}): MetronSeriesHit {
  return { id: "1", name: "The Amazing Spider-Man", yearBegan: 1963, yearEnd: null, publisher: "Marvel", ...overrides };
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

function record(overrides: Partial<CoverRecord> = {}): CoverRecord {
  return { id: "comic-1", coverFile: null, coverStatus: null, metronIssueId: null, ...spider, ...overrides };
}

function gcdIssue(overrides: Partial<GcdIssueRow> = {}): GcdIssueRow {
  return {
    id: "900",
    seriesId: "77",
    seriesName: "The Amazing Spider-Man Facsimile Edition",
    number: "1",
    variant: "Facsimile Edition",
    title: "Spider-Man",
    coverDate: "March 1963",
    coverYear: 1963,
    onSaleYear: 2022,
    onSaleDate: "2022-03-09",
    price: "3.99 USD",
    pageCount: 36,
    barcode: null,
    publisher: "Marvel",
    writer: "Stan Lee",
    artist: "Steve Ditko",
    coverArtist: "Steve Ditko",
    characters: "Spider-Man",
    seriesYear: 2022,
    comicvineIssueId: null,
    metronIssueId: null,
    ...overrides,
  };
}

describe("edition detection", () => {
  it("reads facsimile, reprint, printing, anniversary, True Believers, and omnibus wording", () => {
    expect(detectEdition(spider).kind).toBe("facsimile");
    expect(detectEdition(spider).searchNames[0]).toBe("Amazing Spider-Man Facsimile Edition");
    expect(detectEdition({ ...spider, variantDescription: "Reprint", format: null }).kind).toBe("reprint");
    expect(detectEdition({ ...spider, variantDescription: "2nd Printing", releaseYear: 2014, coverYear: 2014, coverPrice: "3.99" }).kind).toBe("printing");
    expect(detectEdition({ ...spider, variantDescription: "1st printing", releaseYear: 2014, coverYear: 2014, coverPrice: "3.99" }).kind).toBe("regular");
    expect(detectEdition({ ...spider, series: "True Believers Spider-Man", variantDescription: null, releaseYear: 2019, coverYear: 2019 }).searchNames[0]).toBe(
      "True Believers Spider-Man",
    );
    expect(detectEdition({ ...spider, variantDescription: "Anniversary Edition", releaseYear: 2022, coverYear: 2022, coverPrice: "5.99" }).searchNames[0]).toBe(
      "The Amazing Spider-Man Anniversary",
    );
    expect(detectEdition({ ...spider, format: "Omnibus", variantDescription: null, releaseYear: 2020, coverYear: 2020 }).kind).toBe("omnibus");
  });

  it("treats a decades-later release or a modern price on a silver-age cover as a facsimile", () => {
    const byYear = detectEdition({ ...spider, variantDescription: null, coverPrice: "0.12" });
    expect(byYear.kind).toBe("facsimile");
    expect(byYear.reasons.join(" ")).toContain("2022");
    const byPrice = detectEdition({ ...spider, variantDescription: null, releaseYear: null, coverPrice: "4.99" });
    expect(byPrice.kind).toBe("facsimile");
    expect(byPrice.reasons.join(" ")).toContain("4.99");
    expect(detectEdition({ ...spider, variantDescription: null, releaseYear: 1963, coverPrice: "0.12" }).kind).toBe("regular");
  });
});

describe("edition scoring", () => {
  it("refuses the original issue and accepts the facsimile series", () => {
    const original = scoreCandidate(spider, {
      seriesName: "The Amazing Spider-Man",
      issueNo: "1",
      variant: null,
      coverYear: 1963,
      releaseYear: 1963,
      seriesYear: 1963,
      upc: null,
      publisher: "Marvel",
    });
    expect(original.auto).toBe(false);
    expect(original.blocked).toMatch(/years apart|facsimile/);

    const facsimile = scoreCandidate(spider, {
      seriesName: "The Amazing Spider-Man Facsimile Edition",
      issueNo: "1",
      variant: "Facsimile Edition",
      coverYear: 1963,
      releaseYear: 2022,
      seriesYear: 2022,
      upc: null,
      publisher: "Marvel",
    });
    expect(facsimile.auto).toBe(true);
    expect(facsimile.score).toBeGreaterThanOrEqual(75);

    const reprintedCoverDate = scoreCandidate(spider, {
      seriesName: "The Amazing Spider-Man Facsimile Edition",
      issueNo: "1",
      variant: "Facsimile Edition",
      coverYear: 1963,
      releaseYear: null,
      seriesYear: 2022,
      upc: null,
      publisher: "Marvel",
    });
    expect(reprintedCoverDate.auto).toBe(true);
  });

  it("searches the facsimile series before the original and will not auto-link the 1963 issue", async () => {
    const calls: string[] = [];
    const client = lookup({
      async searchSeries(name) {
        calls.push(name);
        if (name.includes("Facsimile")) return [];
        return [seriesHit()];
      },
      async issuesForSeries() {
        return [hit()];
      },
    });
    const missed = await resolveCover(spider, client);
    expect(calls[0]).toBe("Amazing Spider-Man Facsimile Edition");
    expect(calls.some((name) => name === "The Amazing Spider-Man")).toBe(false);
    expect(missed.status).toBe("unmatched");
    expect(missed.score).toBeLessThan(75);

    const found = await resolveCover(
      spider,
      lookup({
        async searchSeries(name) {
          if (name.includes("Facsimile")) return [seriesHit({ id: "77", name, yearBegan: 2022 })];
          return [seriesHit()];
        },
        async issuesForSeries(seriesId) {
          if (seriesId === "77") {
            return [
              hit({
                id: "900",
                seriesId: "77",
                seriesName: "The Amazing Spider-Man Facsimile Edition",
                variant: "Facsimile Edition",
                releaseYear: 2022,
                seriesYear: 2022,
              }),
            ];
          }
          return [hit()];
        },
      }),
    );
    expect(found).toMatchObject({ status: "matched", via: "series", issue: { id: "900" } });
  });
});

describe("suspect matches", () => {
  it("flags a facsimile link and a year gap, and leaves a tight regular link alone", () => {
    expect(suspectMatchReason({ ...spider, metronIssueId: "10" })).toMatch(/facsimile|store year/);
    expect(suspectMatchReason({ ...spider, metronIssueId: "10", catalogStoreYear: 2022 })).toBeNull();
    expect(suspectMatchReason({ ...spider, metronIssueId: "10", catalogStoreYear: 1963 })).toMatch(/1963/);
    expect(suspectMatchReason({ ...spider, metronIssueId: null, gcdIssueId: null })).toBeNull();
    expect(
      suspectMatchReason({
        series: "Saga",
        issueNo: "1",
        coverYear: 2012,
        releaseYear: 2020,
        metronIssueId: "50",
      }),
    ).toMatch(/years apart/);
    expect(
      suspectMatchReason({
        series: "Saga",
        issueNo: "1",
        coverYear: 2012,
        releaseYear: 2012,
        metronIssueId: "50",
      }),
    ).toBeNull();
  });

  it("keeps the re-match refusal and the bulk action", () => {
    const rematch = readFileSync(new URL("../src/lib/covers/facsimile-rematch.ts", import.meta.url), "utf8");
    const actions = readFileSync(new URL("../src/app/covers/actions.ts", import.meta.url), "utf8");
    const suspects = readFileSync(new URL("../src/app/covers/suspect-actions.tsx", import.meta.url), "utf8");
    expect(rematch).toContain("This link was chosen by hand. Unlink it first.");
    expect(rematch).toContain('if (sources[field] !== "metron" && sources[field] !== "gcd") continue;');
    expect(actions).toContain("rematchAllSuspectsAction");
    expect(suspects).toContain("Propose re-matches");
  });
});

describe("GCD catalog", () => {
  it("keeps the cover scan on the match row and off automatic backfill", () => {
    const parsed = parseGcdIssue(
      {
        api_url: "https://www.comics.org/api/issue/256114/",
        series: "https://www.comics.org/api/series/1234/",
        series_name: "The Amazing Spider-Man Facsimile Edition (2022 series)",
        number: "1",
        variant_name: "Facsimile Edition",
        publication_date: "March 1963",
        key_date: "1963-03-01",
        price: "3.99 USD",
        page_count: "36",
        barcode: "75960600000100011",
        on_sale_date: "2022-03-09",
        indicia_publisher: "Marvel",
        cover: "https://files1.comics.org/img/gcd/covers_by_id/1/w400/1.jpg",
        story_set: [
          { type: "cover", pencils: "Steve Ditko (signed)" },
          { type: "comic story", title: "Spider-Man", script: "Stan Lee (plot)", pencils: "Steve Ditko", characters: "Spider-Man" },
        ],
      },
      2022,
    );
    expect(parsed?.seriesName).toBe("The Amazing Spider-Man Facsimile Edition");
    expect(parsed && "cover" in parsed).toBe(false);
    expect(parsed?.coverUrl).toBe("https://files1.comics.org/img/gcd/covers_by_id/1/w400/1.jpg");
    const details = gcdDetails(parsed as GcdIssueRow);
    expect(details.imageUrl).toBeNull();
    expect(details.writer).toBe("Stan Lee");
    expect(details.releaseDate?.toISOString()).toBe("2022-03-09T12:00:00.000Z");
    expect(gcdHit(parsed as GcdIssueRow).coverUrl).toBeNull();
    expect(gcdHit(parsed as GcdIssueRow).covers).toEqual([]);
  });

  it("does not call a GCD barcode URL", async () => {
    resetGcdBudget();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return Response.json({});
    };
    const issues = await createGcdCatalog(fetchImpl).issuesByBarcode("76194137966100111");
    const matches = await gcdByBarcode({ raw: "76194137966100111", digits: "76194137966100111", upc: "761941379661", addon: "00111", combined: "76194137966100111" });
    expect(issues).toEqual([]);
    expect(matches).toEqual([]);
    expect(calls).toBe(0);
  });

  it("asks for the facsimile descriptor before the original issue", async () => {
    const fetched: string[] = [];
    const catalog: GcdCatalog = {
      async seriesByName() {
        return [
          parseGcdSeries({
            api_url: "https://www.comics.org/api/series/77/",
            name: "Amazing Spider-Man No. 1 Facsimile Edition (2022 series)",
            year_began: 2022,
            year_ended: null,
            active_issues: ["https://www.comics.org/api/issue/1/", "https://www.comics.org/api/issue/2/"],
            issue_descriptors: ["1", "1 [Facsimile Edition]"],
          }) as NonNullable<ReturnType<typeof parseGcdSeries>>,
        ];
      },
      async issue(id) {
        fetched.push(id);
        if (id === "2") return gcdIssue({ id: "2" });
        return gcdIssue({ id: "1", seriesName: "The Amazing Spider-Man", variant: null, onSaleYear: 1963, seriesYear: 1963 });
      },
      async issuesByBarcode() {
        return [];
      },
    };
    const decision = await resolveGcdCover(spider, catalog);
    expect(fetched).toEqual(["1", "2"]);
    expect(decision).toMatchObject({ status: "matched", via: "gcd", issue: { id: "2" } });
  });

  it("credits GCD data and does not write Metron ids", () => {
    const detail: MetronDetails = {
      id: "256114",
      seriesId: "1234",
      seriesName: "The Amazing Spider-Man Facsimile Edition",
      number: "1",
      imageUrl: null,
      coverDate: "March 1963",
      coverYear: 1963,
      releaseDate: new Date("2022-03-09T12:00:00.000Z"),
      title: "Spider-Man",
      storyArc: null,
      plot: null,
      pageCount: 36,
      coverPrice: "3.99",
      barcode: null,
      writer: "Stan Lee",
      artist: null,
      coverArtist: null,
      characters: null,
      teams: null,
      imprint: "Marvel",
      seriesYear: 2022,
      seriesVolume: null,
      metronIssueUrl: null,
      metronSeriesUrl: null,
      comicvineIssueId: null,
      comicvineSeriesId: null,
      gcdIssueId: null,
      gcdSeriesId: null,
    };
    const plan = planEnrichment({ writer: null, metronIssueId: null }, detail, {}, "gcd");
    expect(plan.filled).toContain("writer");
    expect(plan.filled).not.toContain("metronIssueId");
    expect(plan.sources.writer).toBe("gcd");
    expect(fieldCredit(plan.sources, "writer")).toBe("Data from GCD");
  });
});

describe("GCD before Metron", () => {
  it("asks GCD first for a facsimile and still tries Metron when GCD misses", async () => {
    const order: string[] = [];
    const first = await backfillCovers({
      comics: [record()],
      lookup: lookup({
        async searchSeries() {
          order.push("metron");
          return [];
        },
      }),
      fileExists: () => false,
      saveImage: async () => "nope.jpg",
      markMatched: async () => {
        throw new Error("Metron should not match");
      },
      markUnmatched: async () => {},
      gcd: async () => {
        order.push("gcd");
        return { status: "matched", via: "gcd", score: 90, issue: hit({ id: "2513854", imageUrl: null, seriesName: "Batman: Vengeance of Bane 1 (Facsimile Edition)", number: "[nn]" }) };
      },
      markGcd: async () => {},
    });
    expect(first.matched).toBe(1);
    expect(order).toEqual(["gcd"]);

    order.length = 0;
    const second = await backfillCovers({
      comics: [record({ barcode: null })],
      lookup: lookup({
        async searchSeries() {
          order.push("metron");
          return [{ id: "77", name: "The Amazing Spider-Man Facsimile Edition", yearBegan: 2022, yearEnd: null, publisher: "Marvel" }];
        },
        async issuesForSeries() {
          return [hit({ id: "fac", seriesName: "The Amazing Spider-Man Facsimile Edition", number: "1", coverYear: 2022, releaseYear: 2022, seriesYear: 2022, storeDate: "2022-03-09", publisher: "Marvel", variant: "Facsimile Edition" })];
        },
      }),
      fileExists: () => false,
      saveImage: async () => "metron-fac.jpg",
      markMatched: async () => {},
      markUnmatched: async () => {},
      gcd: async () => {
        order.push("gcd");
        return { status: "unmatched", reason: "No facsimile issue for The Amazing Spider-Man #1.", score: 0 };
      },
      markGcd: async () => {
        throw new Error("should not link");
      },
    });
    expect(order[0]).toBe("gcd");
    expect(order).toContain("metron");
    expect(second.matched).toBe(1);
  });
});

describe("GCD backfill fallback", () => {
  it("links GCD without downloading a cover, and a rate limit does not stop Metron", async () => {
    const saved: string[] = [];
    const gcdLinks: string[] = [];
    const logs: string[] = [];
    const first = await backfillCovers({
      comics: [record({ barcode: null })],
      lookup: lookup({
        async searchSeries() {
          return [seriesHit()];
        },
        async issuesForSeries() {
          return [hit()];
        },
      }),
      fileExists: () => false,
      saveImage: async (issue) => {
        saved.push(issue.id);
        return `metron-${issue.id}.jpg`;
      },
      markMatched: async () => {
        throw new Error("Metron should not match the original");
      },
      markUnmatched: async () => {},
      gcd: async () => ({
        status: "matched",
        via: "gcd",
        score: 90,
        issue: hit({ id: "900", imageUrl: "https://files1.comics.org/cover.jpg" }),
      }),
      markGcd: async (_id, update) => {
        gcdLinks.push(update.gcdIssueId);
      },
      log: (line) => logs.push(line),
    });
    expect(first.matched).toBe(1);
    expect(saved).toEqual([]);
    expect(gcdLinks).toEqual(["900"]);
    expect(logs.join("\n")).toMatch(/matched GCD 900, score 90/);

    let gcdCalls = 0;
    const second = await backfillCovers({
      comics: [
        record({ id: "miss", series: "Planet Slammer", barcode: null, variantDescription: null, releaseYear: 2012, coverYear: 2012, coverPrice: null }),
        record({
          id: "saga",
          series: "Saga",
          issueNo: "1",
          issue: "1",
          coverYear: 2012,
          releaseYear: 2012,
          barcode: "07596060000100001",
          variantDescription: null,
          publisher: "Image",
          coverPrice: "2.99",
        }),
      ],
      lookup: lookup({
        async issuesByUpc() {
          return [
            hit({
              id: "50",
              seriesName: "Saga",
              coverYear: 2012,
              releaseYear: 2012,
              seriesYear: 2012,
              publisher: "Image",
            }),
          ];
        },
      }),
      fileExists: () => false,
      saveImage: async () => "metron-50.jpg",
      markMatched: async () => {},
      markUnmatched: async () => {},
      gcd: async () => {
        gcdCalls += 1;
        throw new GcdBudgetError("GCD rate limit reached. Later copies will stay unmatched.");
      },
      markGcd: async () => {
        throw new Error("should not link");
      },
      log: (line) => logs.push(line),
    });
    expect(gcdCalls).toBe(1);
    expect(second).toMatchObject({ matched: 1, unmatched: 1, stoppedReason: null });
    expect(logs.join("\n")).toContain("GCD is paused. Metron matching continues.");
  });
});
