import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGcdIssue, parseGcdSeries, type GcdCatalog, type GcdIssueRow, type GcdSeriesRow } from "@/lib/catalog/gcd";
import { detectEdition, scoreCandidate, stripIssueVariant } from "@/lib/covers/edition";
import { runFacsimilePass } from "@/lib/covers/facsimile-once";
import { gcdFacsimileQueries, resolveGcdCover, searchGcdMatches } from "@/lib/covers/gcd-match";
import { resolveCover } from "@/lib/covers/match";
import type { CoverLookup, CoverQuery, MetronIssueHit, MetronSeriesHit } from "@/lib/covers/types";

type Example = {
  series: string;
  issueNo: string;
  variantDescription: string;
  releaseDate: string;
  barcode: string;
  publisher: string;
  number: string;
};

const examples: Example[] = [
  { series: "The Amazing Spider-Man, Vol. 1", issueNo: "300K", variantDescription: "Facsimile", releaseDate: "2023-08-23", barcode: "75960620687200111", publisher: "Marvel", number: "300" },
  { series: "The Amazing Spider-Man, Vol. 1", issueNo: "300L", variantDescription: "Facsimile Foil Variant", releaseDate: "2023-08-23", barcode: "75960620687200121", publisher: "Marvel", number: "300" },
  { series: "The Amazing Spider-Man, Vol. 1", issueNo: "129I", variantDescription: "Facsimile 2024", releaseDate: "2025-02-12", barcode: "75960621241512911", publisher: "Marvel", number: "129" },
  { series: "The Amazing Spider-Man, Vol. 1", issueNo: "1G", variantDescription: "2022 Facsimile Edition", releaseDate: "2022-10-05", barcode: "75960620411300111", publisher: "Marvel", number: "1" },
  { series: "The Avengers, Vol. 1", issueNo: "8C", variantDescription: "Facsimile Edition", releaseDate: "2023-02-08", barcode: "75960620544800111", publisher: "Marvel", number: "8" },
  { series: "Batman, Vol. 1", issueNo: "1K", variantDescription: "Facsimile", releaseDate: "2023-09-12", barcode: "76194138217300111", publisher: "DC", number: "1" },
  { series: "Batman: Vengeance of Bane", issueNo: "1D", variantDescription: "Facsimile Edition 2023", releaseDate: "2023-04-04", barcode: "76194137966100111", publisher: "DC", number: "1" },
  { series: "All-New Marvel NOW! Point One", issueNo: "1D", variantDescription: "Facsimile Edition", releaseDate: "2023-07-26", barcode: "75960620684100111", publisher: "Marvel", number: "1" },
];

function copyOf(example: Example, overrides: Partial<CoverQuery> = {}): CoverQuery {
  return {
    series: example.series,
    issueNo: example.issueNo,
    issue: example.issueNo,
    coverYear: null,
    releaseYear: Number(example.releaseDate.slice(0, 4)),
    releaseDate: example.releaseDate,
    barcode: example.barcode,
    variant: null,
    variantDescription: example.variantDescription,
    format: null,
    publisher: example.publisher,
    coverPrice: "4.99",
    seriesYear: 1963,
    ...overrides,
  };
}

function facsimileHit(example: Example, overrides: Partial<MetronIssueHit> = {}): MetronIssueHit {
  const base = example.series.replace(/^\s*the\s+/i, "").replace(/,?\s+\bvol(?:ume)?\.?\s*\d+\s*$/i, "");
  return {
    id: `fac-${example.number}`,
    seriesId: "77",
    seriesName: `${base} #${example.number} Facsimile Edition`,
    number: "1",
    coverYear: Number(example.releaseDate.slice(0, 4)),
    imageUrl: "https://static.metron.cloud/facsimile.jpg",
    label: "Facsimile",
    releaseYear: Number(example.releaseDate.slice(0, 4)),
    seriesYear: Number(example.releaseDate.slice(0, 4)),
    storeDate: example.releaseDate,
    upc: example.barcode,
    publisher: example.publisher,
    variant: "Facsimile Edition",
    ...overrides,
  };
}

function gcdFacsimileIssue(id: string, seriesName: string, onSaleDate: string, barcode: string, variant: string | null = null): GcdIssueRow {
  return {
    id,
    seriesId: "gcd-series",
    seriesName,
    number: "[nn]",
    variant,
    title: null,
    coverDate: onSaleDate,
    coverYear: Number(onSaleDate.slice(0, 4)),
    onSaleYear: Number(onSaleDate.slice(0, 4)),
    onSaleDate,
    price: "6.99 USD",
    pageCount: 32,
    barcode,
    publisher: "DC",
    writer: null,
    artist: null,
    coverArtist: null,
    characters: null,
    seriesYear: Number(onSaleDate.slice(0, 4)),
    comicvineIssueId: null,
    metronIssueId: null,
  };
}

function originalHit(example: Example): MetronIssueHit {
  return facsimileHit(example, {
    id: `orig-${example.number}`,
    seriesId: "1",
    seriesName: example.series.replace(/,?\s+\bvol(?:ume)?\.?\s*\d+\s*$/i, ""),
    number: example.number,
    coverYear: 1963,
    releaseYear: 1963,
    seriesYear: 1963,
    storeDate: "1963-03-01",
    upc: null,
    imageUrl: "https://static.metron.cloud/original.jpg",
    variant: null,
    label: null,
  });
}

function lookup(impl: Partial<CoverLookup> & { calls?: string[] } = {}): CoverLookup & { calls: string[] } {
  const calls = impl.calls ?? [];
  return {
    calls,
    async issuesByUpc(upc) {
      calls.push(`upc:${upc}`);
      return impl.issuesByUpc ? impl.issuesByUpc(upc) : [];
    },
    async issuesByUpcPrefix(upc) {
      calls.push(`prefix:${upc}`);
      return impl.issuesByUpcPrefix ? impl.issuesByUpcPrefix(upc) : [];
    },
    async searchSeries(name) {
      calls.push(`series:${name}`);
      return impl.searchSeries ? impl.searchSeries(name) : [];
    },
    async issuesForSeries(seriesId, number, coverYear) {
      calls.push(`issues:${seriesId}:${number}:${coverYear ?? ""}`);
      return impl.issuesForSeries ? impl.issuesForSeries(seriesId, number, coverYear) : [];
    },
  };
}

describe("CLZ facsimile variants", () => {
  it("reads facsimile from the variant description and strips the variant letter", () => {
    for (const example of examples) {
      const edition = detectEdition(copyOf(example));
      expect(edition.kind, example.issueNo).toBe("facsimile");
      expect(edition.issueNo, example.series).toBe(example.number);
      expect(stripIssueVariant(example.issueNo).number).toBe(example.number);
      const base = example.series.replace(/^\s*the\s+/i, "").replace(/,?\s+\bvol(?:ume)?\.?\s*\d+\s*$/i, "");
      expect(edition.facsimileSearches.map((search) => `${search.series} #${search.issueNo}`)).toEqual([
        `${base} Facsimile Edition #${example.number}`,
        `${base} Facsimile #${example.number}`,
        `${base} #${example.number} Facsimile Edition #1`,
        `${base} ${example.number} (Facsimile Edition) #1`,
        `${base} #${example.number} (Facsimile Edition) #1`,
      ]);
    }
    const byFormat = detectEdition(copyOf(examples[0], { variantDescription: null, format: "Facsimile" }));
    expect(byFormat.kind).toBe("facsimile");
    const bySeriesStart = detectEdition(
      copyOf(examples[0], { variantDescription: null, format: null, coverYear: null, seriesYear: 1963, releaseYear: 2023 }),
    );
    expect(bySeriesStart.kind).toBe("facsimile");
    const modernRegular = detectEdition(
      copyOf(examples[0], { variantDescription: null, format: null, issueNo: "900", coverYear: 2023, seriesYear: 1963, releaseYear: 2023, barcode: null }),
    );
    expect(modernRegular.kind).toBe("regular");
  });

  it("matches each example by the full UPC and never the original issue", async () => {
    for (const example of examples) {
      const calls: string[] = [];
      const client = lookup({
        calls,
        async issuesByUpc(upc) {
          if (upc === example.barcode) return [facsimileHit(example), originalHit(example)];
          return [originalHit(example)];
        },
        async searchSeries() {
          return [];
        },
      });
      const decision = await resolveCover(copyOf(example), client);
      expect(decision, example.issueNo).toMatchObject({ status: "matched", via: "barcode", issue: { id: `fac-${example.number}` } });
      expect(calls[0]).toBe(`upc:${example.barcode}`);
      expect(calls[1]).toBe(`upc:${example.barcode.slice(0, 12)}`);
      expect(calls.some((call) => call.startsWith("series:") && !/facsimile/i.test(call))).toBe(false);
    }
  });

  it("maps a foil facsimile onto the foil cover of the facsimile issue", async () => {
    const example = examples[1];
    const regular = "https://static.metron.cloud/asm-300.jpg";
    const foil = "https://static.metron.cloud/asm-300-foil.jpg";
    const decision = await resolveCover(
      copyOf(example),
      lookup({
        async issuesByUpc(upc) {
          if (upc === example.barcode) return [];
          if (upc === example.barcode.slice(0, 12)) {
            return [
              facsimileHit(example, {
                upc: "75960620687200111",
                imageUrl: regular,
                covers: [
                  { label: "Cover", imageUrl: regular },
                  { label: "Foil Variant", imageUrl: foil },
                ],
              }),
            ];
          }
          return [];
        },
      }),
    );
    expect(decision).toMatchObject({ status: "matched", issue: { id: "fac-300", imageUrl: foil } });
  });

  it("accepts a facsimile series issue 1 and rejects a store date outside 60 days", async () => {
    const example = examples[0];
    const seriesName = "Amazing Spider-Man #300 Facsimile Edition";
    const found = await resolveCover(
      copyOf(example, { barcode: null }),
      lookup({
        async searchSeries(name) {
          if (name === seriesName) return [{ id: "77", name: seriesName, yearBegan: 2023, yearEnd: null, publisher: "Marvel" } satisfies MetronSeriesHit];
          return [];
        },
        async issuesForSeries() {
          return [facsimileHit(example, { upc: null })];
        },
      }),
    );
    expect(found).toMatchObject({ status: "matched", via: "series", issue: { id: "fac-300" } });

    const stale = await resolveCover(
      copyOf(example, { barcode: null }),
      lookup({
        async searchSeries(name) {
          if (name.includes("Facsimile")) return [{ id: "77", name, yearBegan: 2020, yearEnd: null, publisher: "Marvel" }];
          return [{ id: "1", name: "Amazing Spider-Man", yearBegan: 1963, yearEnd: null, publisher: "Marvel" }];
        },
        async issuesForSeries() {
          return [facsimileHit(example, { storeDate: "2020-01-01", releaseYear: 2020, seriesYear: 2020, upc: null })];
        },
      }),
    );
    expect(stale.status).toBe("unmatched");
    expect(scoreCandidate(copyOf(example), {
      seriesName: "The Amazing Spider-Man",
      issueNo: "300",
      variant: null,
      coverYear: 1988,
      releaseYear: 1988,
      seriesYear: 1963,
      storeDate: "1988-05-01",
      upc: null,
      publisher: "Marvel",
    }).auto).toBe(false);
  });

  it("leaves the copy unmatched when Metron and GCD only know the original", async () => {
    const example = examples[6];
    const missed = await resolveCover(
      copyOf(example),
      lookup({
        async issuesByUpc() {
          return [originalHit(example)];
        },
        async searchSeries() {
          return [{ id: "1", name: "Batman: Vengeance of Bane", yearBegan: 1993, yearEnd: 1993, publisher: "DC" }];
        },
        async issuesForSeries() {
          return [originalHit(example)];
        },
      }),
    );
    expect(missed.status).toBe("unmatched");

    const catalog: GcdCatalog = {
      async issuesByBarcode() {
        return [
          {
            id: "10",
            seriesId: "2",
            seriesName: "Batman: Vengeance of Bane",
            number: "1",
            variant: null,
            title: null,
            coverDate: "January 1993",
            coverYear: 1993,
            onSaleYear: 1993,
            onSaleDate: "1993-01-01",
            price: "1.25 USD",
            pageCount: 32,
            barcode: example.barcode,
            publisher: "DC",
            writer: null,
            artist: null,
            coverArtist: null,
            characters: null,
            seriesYear: 1993,
            comicvineIssueId: null,
            metronIssueId: null,
          } satisfies GcdIssueRow,
        ];
      },
      async seriesByName() {
        return [];
      },
      async issue() {
        return null;
      },
    };
    const gcd = await resolveGcdCover(copyOf(example), catalog);
    expect(gcd.status).toBe("unmatched");
  });

  it("links a GCD facsimile from the 12-digit UPC when the full code is absent", async () => {
    const example = examples[4];
    const base = example.barcode.slice(0, 12);
    const asked: string[] = [];
    const issue: GcdIssueRow = {
      id: "880",
      seriesId: "90",
      seriesName: "Avengers No. 8 Facsimile Edition",
      number: "[nn]",
      variant: "Facsimile Edition",
      title: "The Avengers",
      coverDate: "September 1964",
      coverYear: 1964,
      onSaleYear: 2023,
      onSaleDate: "2023-02-08",
      price: "4.99 USD",
      pageCount: 36,
      barcode: base,
      publisher: "Marvel",
      writer: "Stan Lee",
      artist: null,
      coverArtist: null,
      characters: null,
      seriesYear: 2023,
      comicvineIssueId: null,
      metronIssueId: null,
    };
    const catalog: GcdCatalog = {
      async issuesByBarcode() {
        return [];
      },
      async seriesByName(name) {
        asked.push(name);
        if (name !== "Avengers No. 8") return [];
        return [
          {
            id: "90",
            name: "Avengers No. 8 Facsimile Edition",
            yearBegan: 2023,
            yearEnded: 2023,
            format: "one-shot",
            issues: [{ id: "880", descriptor: "" }],
          },
        ];
      },
      async issue(id) {
        return id === "880" ? issue : null;
      },
    };
    const decision = await resolveGcdCover(copyOf(example), catalog);
    expect(asked).toContain("Avengers No. 8");
    expect(decision).toMatchObject({ status: "matched", via: "gcd", issue: { id: "880" } });
  });

  it("queries the core series name and skips the original series", async () => {
    const bane = examples[6];
    const batman = examples[5];
    const cases = [
      { example: bane, query: "Vengeance of Bane", seriesName: "Batman: Vengeance of Bane 1 (Facsimile Edition)", id: "bane-fac" },
      { example: batman, query: "Batman 1", seriesName: "Batman 1 (Facsimile Edition)", id: "batman-fac" },
    ];
    for (const { example, query, seriesName, id } of cases) {
      const asked: string[] = [];
      const catalog: GcdCatalog = {
        async issuesByBarcode() {
          return [];
        },
        async seriesByName(name) {
          asked.push(name);
          if (name !== query) {
            return [
              {
                id: "original-series",
                name: example.series.replace(/,?\s+\bvol(?:ume)?\.?\s*\d+\s*$/i, ""),
                yearBegan: 1939,
                yearEnded: null,
                format: "series",
                issues: [{ id: "original-issue", descriptor: example.number }],
              },
            ];
          }
          return [
            {
              id: "original-series",
              name: example.series.replace(/,?\s+\bvol(?:ume)?\.?\s*\d+\s*$/i, ""),
              yearBegan: 1939,
              yearEnded: null,
              format: "series",
              issues: [{ id: "original-issue", descriptor: example.number }],
            },
            {
              id: `${id}-series`,
              name: seriesName,
              yearBegan: 2023,
              yearEnded: 2023,
              format: "one-shot",
              issues: [{ id, descriptor: "" }],
            },
          ];
        },
        async issue(issueId) {
          if (issueId !== id) return null;
          return {
            id,
            seriesId: `${id}-series`,
            seriesName,
            number: "[nn]",
            variant: null,
            title: null,
            coverDate: "April 2023",
            coverYear: 2023,
            onSaleYear: 2023,
            onSaleDate: example.releaseDate,
            price: "4.99 USD",
            pageCount: 32,
            barcode: null,
            publisher: "DC",
            writer: null,
            artist: null,
            coverArtist: null,
            characters: null,
            seriesYear: 2023,
            comicvineIssueId: null,
            metronIssueId: null,
          } satisfies GcdIssueRow;
        },
      };
      const decision = await resolveGcdCover(copyOf(example, { barcode: null }), catalog);
      expect(decision, seriesName).toMatchObject({ status: "matched", via: "gcd", issue: { id } });
      expect(asked[0]).toBe(query);
    }
  });

  it("links a GCD [nn] facsimile when the series title carries the issue number and the barcode matches", async () => {
    const batman = examples[5];
    const foilBarcode = "76194138217300121";
    const fetched: string[] = [];
    const catalog: GcdCatalog = {
      async issuesByBarcode() {
        return [];
      },
      async seriesByName(name) {
        if (name !== "Batman 1") return [];
        return [
          {
            id: "later",
            name: "Batman 1 (Facsimile Edition)",
            yearBegan: 2025,
            yearEnded: null,
            format: "series",
            issues: [{ id: "later-main", descriptor: "" }],
          },
          {
            id: "2023",
            name: "Batman 1 (Facsimile Edition)",
            yearBegan: 2023,
            yearEnded: null,
            format: "series",
            issues: [
              { id: "main", descriptor: "" },
              { id: "foil", descriptor: "[Foil Cardstock Cover]" },
            ],
          },
        ];
      },
      async issue(id) {
        fetched.push(id);
        if (id === "later-main") {
          return gcdFacsimileIssue(id, "Batman 1 (Facsimile Edition)", "2025-09-17", "76194138717800111");
        }
        if (id === "foil") return gcdFacsimileIssue(id, "Batman 1 (Facsimile Edition)", batman.releaseDate, foilBarcode, "Foil Cardstock Cover");
        if (id === "main") return gcdFacsimileIssue(id, "Batman 1 (Facsimile Edition)", batman.releaseDate, batman.barcode);
        return null;
      },
    };
    const regular = await resolveGcdCover(copyOf(batman, { barcode: batman.barcode }), catalog);
    expect(regular).toMatchObject({ status: "matched", via: "gcd", issue: { id: "main" } });
    expect(fetched).not.toContain("later-main");

    fetched.length = 0;
    const foil = await resolveGcdCover(
      copyOf(batman, { barcode: foilBarcode, variantDescription: "Facsimile Foil Variant" }),
      catalog,
    );
    expect(foil).toMatchObject({ status: "matched", via: "gcd", issue: { id: "foil" } });
  });

  it("keeps looking when an earlier facsimile series has a different barcode", async () => {
    const spider = examples[3];
    const asked: string[] = [];
    const catalog: GcdCatalog = {
      async issuesByBarcode() {
        return [];
      },
      async seriesByName(name) {
        asked.push(name);
        if (name === "Amazing Spider-Man 1") {
          return [
            {
              id: "2021",
              name: "Amazing Spider-Man 1 Facsimile",
              yearBegan: 2021,
              yearEnded: 2021,
              format: "one-shot",
              issues: [{ id: "earlier", descriptor: "" }],
            },
          ];
        }
        if (name === "Amazing Spider-Man No. 1") {
          return [
            {
              id: "2022",
              name: "Amazing Spider-Man No. 1 Facsimile Edition",
              yearBegan: 2022,
              yearEnded: 2022,
              format: "one-shot",
              issues: [{ id: "right", descriptor: "" }],
            },
          ];
        }
        return [];
      },
      async issue(id) {
        if (id === "earlier") {
          return { ...gcdFacsimileIssue(id, "Amazing Spider-Man 1 Facsimile", "2021-01-20", "75960620000000111"), publisher: "Marvel" };
        }
        if (id === "right") {
          return { ...gcdFacsimileIssue(id, "Amazing Spider-Man No. 1 Facsimile Edition", spider.releaseDate, spider.barcode), publisher: "Marvel" };
        }
        return null;
      },
    };
    const decision = await resolveGcdCover(copyOf(spider), catalog);
    expect(asked.slice(0, 3)).toEqual(["Amazing Spider-Man", "Amazing Spider-Man 1", "Amazing Spider-Man No. 1"]);
    expect(decision).toMatchObject({ status: "matched", via: "gcd", issue: { id: "right" } });
  });

  it("does not auto-link a foil add-on onto the regular barcode", async () => {
    const foil = examples[1];
    const catalog: GcdCatalog = {
      async issuesByBarcode() {
        return [];
      },
      async seriesByName(name) {
        if (name !== "Amazing Spider-Man 300" && name !== "Amazing Spider-Man No. 300") return [];
        return [
          {
            id: "300",
            name: "Amazing Spider-Man No. 300 Facsimile Edition",
            yearBegan: 2023,
            yearEnded: 2023,
            format: "one-shot",
            issues: [{ id: "regular", descriptor: "" }],
          },
        ];
      },
      async issue(id) {
        if (id !== "regular") return null;
        return {
          ...gcdFacsimileIssue(id, "Amazing Spider-Man No. 300 Facsimile Edition", foil.releaseDate, "75960620687200111"),
          publisher: "Marvel",
        };
      },
    };
    const decision = await resolveGcdCover(copyOf(foil), catalog);
    expect(decision.status).toBe("unmatched");
  });
});

describe("Vengeance of Bane facsimile fixture", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/gcd/vengeance-of-bane.json", import.meta.url), "utf8")) as {
    series: { results: unknown[] };
    issue: unknown;
  };
  const series = fixture.series.results.map((row) => parseGcdSeries(row)).filter((row): row is GcdSeriesRow => row !== null);
  const issue = parseGcdIssue(fixture.issue);

  function catalog(asked: string[]): GcdCatalog {
    return {
      async seriesByName(name) {
        asked.push(name);
        return /vengeance of bane/i.test(name) ? series : [];
      },
      async issue(id) {
        if (id === "2513854") return issue;
        if (id === "2514867") {
          return {
            ...(issue as GcdIssueRow),
            id: "2514867",
            barcode: "76194137966100121",
            variant: "Foil Cardstock Cover",
          };
        }
        return null;
      },
      async issuesByBarcode() {
        return [];
      },
    };
  }

  it("names the core series, including the part after Batman:", () => {
    expect(gcdFacsimileQueries("Batman: Vengeance of Bane", "1")[0]).toBe("Vengeance of Bane");
    expect(gcdFacsimileQueries("Batman: Vengeance of Bane Facsimile Edition #1 2023", "1")[0]).toBe("Vengeance of Bane");
    expect(gcdFacsimileQueries("Batman: Vengeance of Bane Facsimile Edition #1 2023", "1").some((query) => /facsimile|2023/i.test(query))).toBe(false);
    expect(gcdFacsimileQueries("The Amazing Spider-Man, Vol. 1", "300")).toContain("Amazing Spider-Man No. 300");
    expect(gcdFacsimileQueries("Batman, Vol. 1", "1")[0]).toBe("Batman 1");
    expect(gcdFacsimileQueries("Batman, Vol. 1", "1")).not.toContain("Batman");
    expect(gcdFacsimileQueries("The Avengers, Vol. 1", "8")).toContain("Avengers No. 8");
  });

  it("resolves Batman: Vengeance of Bane 1D Facsimile Edition 2023 to GCD issue 2513854", async () => {
    const bane = examples[6];
    expect(issue?.id).toBe("2513854");
    expect(issue?.number).toBe("[nn]");
    expect(issue?.barcode).toBe("76194137966100111");
    expect(series.map((row) => row.id)).toContain("198517");

    const asked: string[] = [];
    const decision = await resolveGcdCover(copyOf(bane), catalog(asked));
    expect(decision).toMatchObject({ status: "matched", via: "gcd", issue: { id: "2513854" } });
    expect(asked[0]).toBe("Vengeance of Bane");

    const hits = await searchGcdMatches("Batman: Vengeance of Bane Facsimile Edition #1 2023", bane.barcode, "barcode", null, {
      facsimile: true,
      catalog: catalog([]),
    });
    expect(hits.map((hit) => hit.id)).toEqual(["2513854", "2514867"]);
  });
});

describe("one-time facsimile re-match", () => {
  it("runs once, skips hand-picked links, and does not mark done when the limiter stops it", async () => {
    let done = false;
    const seen: string[] = [];
    const summary = await runFacsimilePass({
      already: async () => done,
      markDone: async () => {
        done = true;
      },
      ids: async () => [
        { id: "auto", manual: false },
        { id: "hand", manual: true },
      ],
      rematch: async (id) => {
        seen.push(id);
        return "matched";
      },
    });
    expect(seen).toEqual(["auto"]);
    expect(summary).toMatchObject({ matched: 1, skipped: 1, done: true });
    const again = await runFacsimilePass({
      already: async () => done,
      markDone: async () => {
        throw new Error("should not run again");
      },
      ids: async () => [{ id: "auto", manual: false }],
      rematch: async () => "matched",
    });
    expect(again.matched).toBe(0);

    let marked = false;
    const stopped = await runFacsimilePass({
      already: async () => false,
      markDone: async () => {
        marked = true;
      },
      ids: async () => [{ id: "auto", manual: false }],
      rematch: async () => "stopped",
    });
    expect(stopped.done).toBe(false);
    expect(marked).toBe(false);
  });
});
