import { afterEach, describe, expect, it, vi } from "vitest";
import { groupSeries, seriesCardCountLabel, type ShelfComic } from "@/lib/collection";
import { runInLane } from "@/lib/catalog/rate-lane";
import { backfillCovers, needsCover } from "@/lib/covers/backfill";
import { scoreCandidate } from "@/lib/covers/edition";
import { METRON_FALLBACK_BURST, METRON_INTERACTIVE_RESERVE, METRON_SAFETY_REMAINING } from "@/lib/catalog/rate-limit";
import { emptyBudget, METRON_DAILY_LIMIT, METRON_MIN_INTERVAL_MS, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import { chooseIssue, narrowSeries, resolveCover } from "@/lib/covers/match";
import {
  METRON_CIRCUIT_BASE_MS,
  METRON_CIRCUIT_MAX_MS,
  readMetronCircuit,
  recordMetronTransportFailure,
  recordMetronTransportSuccess,
  resetMetronCircuit,
} from "@/lib/covers/metron-circuit";
import {
  armMetronJobBudget,
  basicAuthHeader,
  clearMetronJobBudget,
  createMetronCoverLookup,
  mapIssue,
  mapSeries,
  METRON_JOB_LIMIT,
  type MetronTransport,
} from "@/lib/covers/metron-client";
import { MetronBudgetError, type CoverLookup, type CoverQuery, type CoverRecord, type MetronIssueHit, type MetronSeriesHit } from "@/lib/covers/types";
import * as logWrite from "@/lib/log/write";
import { safeImageUrl } from "@/lib/url";

const image = "https://static.metron.cloud/media/issue/saga-1.jpg";

function query(overrides: Partial<CoverQuery> = {}): CoverQuery {
  return {
    series: "Saga",
    issueNo: "1",
    issue: "1",
    coverYear: 2012,
    barcode: "07596060000100001",
    variant: null,
    publisher: "Image",
    ...overrides,
  };
}

function issue(overrides: Partial<MetronIssueHit> = {}): MetronIssueHit {
  return {
    id: "50",
    seriesId: "15",
    seriesName: "Saga",
    number: "1",
    coverYear: 2012,
    imageUrl: image,
    label: "Saga (2012) #1",
    ...overrides,
  };
}

function series(overrides: Partial<MetronSeriesHit> = {}): MetronSeriesHit {
  return { id: "15", name: "Saga", yearBegan: 2012, yearEnd: null, publisher: "Image", ...overrides };
}

function lookup(overrides: Partial<CoverLookup> = {}): CoverLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async issuesByUpc(upc) {
      calls.push(`upc:${upc}`);
      return [];
    },
    async issuesByUpcPrefix(upc) {
      calls.push(`prefix:${upc}`);
      return [];
    },
    async searchSeries(name) {
      calls.push(`series:${name}`);
      return [];
    },
    async issuesForSeries(seriesId, number, coverYear) {
      calls.push(`issues:${seriesId}:${number}:${coverYear ?? ""}`);
      return [];
    },
    ...overrides,
  };
}

function record(overrides: Partial<CoverRecord> = {}): CoverRecord {
  return { id: "comic-1", coverFile: null, coverStatus: null, metronIssueId: null, ...query(), ...overrides };
}

function memoryStore(initial?: Partial<MetronBudget>): { store: BudgetStore; budget: MetronBudget } {
  const budget: MetronBudget = { ...emptyBudget(), ...initial };
  return {
    budget,
    store: {
      read: () => budget,
      write: (next) => {
        budget.day = next.day;
        budget.count = next.count;
        budget.lastRequestAt = next.lastRequestAt;
      },
    },
  };
}

describe("Metron cover matching", () => {
  it("prefers a barcode hit and does not search series", async () => {
    const client = lookup({
      async issuesByUpc(upc) {
        expect(upc).toBe("07596060000100001");
        return [issue()];
      },
      async searchSeries() {
        throw new Error("series search should not run");
      },
    });
    const decision = await resolveCover(query(), client);
    expect(decision).toMatchObject({ status: "matched", via: "barcode", issue: { id: "50" } });
  });

  it("falls back to the 12-digit UPC when the full barcode misses", async () => {
    const client = lookup({
      async issuesByUpcPrefix(upc) {
        expect(upc).toBe("075960600001");
        return [issue()];
      },
    });
    const decision = await resolveCover(query(), client);
    expect(decision).toMatchObject({ status: "matched", via: "barcode" });
    expect(client.calls).toEqual(["upc:07596060000100001"]);
  });

  it("matches series name, issue number, and cover year when the barcode misses", async () => {
    const client = lookup({
      async searchSeries() {
        return [series(), series({ id: "99", name: "Saga of the Swamp Thing", yearBegan: 1982 })];
      },
      async issuesForSeries(seriesId, number, coverYear) {
        expect(seriesId).toBe("15");
        expect(number).toBe("1");
        expect(coverYear).toBe(2012);
        return [issue()];
      },
    });
    const decision = await resolveCover(query({ barcode: "" }), client);
    expect(decision).toMatchObject({ status: "matched", via: "series", issue: { id: "50" } });
  });

  it("picks the volume that was running in the cover year", () => {
    const hits = [
      series({ id: "1", name: "Detective Comics", yearBegan: 1937, yearEnd: 2011, publisher: "DC" }),
      series({ id: "2", name: "Detective Comics", yearBegan: 2011, yearEnd: null, publisher: "DC" }),
    ];
    expect(narrowSeries(hits, query({ series: "Detective Comics", publisher: "DC", coverYear: 1939 })).map((hit) => hit.id)).toEqual(["1"]);
    expect(narrowSeries(hits, query({ series: "Detective Comics", publisher: "DC", coverYear: 2016 })).map((hit) => hit.id)).toEqual(["2"]);
  });

  it("rejects the wrong cover year and an ambiguous barcode", () => {
    const comic = query({ barcode: null });
    expect(chooseIssue([issue({ coverYear: 2014 })], comic, "1", "series")).toMatchObject({
      status: "unmatched",
    });
    expect(chooseIssue([issue({ coverYear: 2014 })], comic, "1", "series").score).toBeLessThan(75);
    expect(
      chooseIssue([issue({ id: "50" }), issue({ id: "51", label: "Saga (2012) #1 B" })], comic, "1", "barcode"),
    ).toMatchObject({ status: "unmatched", reason: "Several Metron issues share this barcode (50, 51)." });
  });

  it("refuses a barcode hit whose year is decades off", () => {
    const decision = chooseIssue([issue({ coverYear: 1999 })], query(), "1", "barcode");
    expect(decision.status).toBe("unmatched");
    expect(decision.score).toBeLessThan(75);
  });

  it("logs a miss when Metron has no series", async () => {
    const decision = await resolveCover(query({ barcode: null, series: "Planet Slammer" }), lookup());
    expect(decision).toEqual({ status: "unmatched", reason: "No Metron series named Planet Slammer.", score: 0 });
  });

  it("searches the name without the volume and year, then filters on those fields", async () => {
    const asked: Array<{ name: string; volume?: number | null; yearBegan?: number | null }> = [];
    const client = lookup({
      async searchSeries(name, filters) {
        asked.push({ name, volume: filters?.volume, yearBegan: filters?.yearBegan });
        if (name === "Action Comics") {
          return [
            series({ id: "ac1", name: "Action Comics", yearBegan: 1938, yearEnd: 2011, publisher: "DC", volume: 1 }),
            series({ id: "ac2", name: "Action Comics", yearBegan: 2011, publisher: "DC", volume: 2 }),
          ];
        }
        if (name === "Ghost Rider") {
          return [
            series({ id: "gr1", name: "Ghost Rider", yearBegan: 1990, yearEnd: null, publisher: "Marvel", volume: 1 }),
            series({ id: "gr2", name: "Ghost Rider", yearBegan: 1990, yearEnd: 1998, publisher: "Marvel", volume: 2 }),
          ];
        }
        return [];
      },
      async issuesForSeries(seriesId) {
        const ghost = seriesId.startsWith("gr");
        return [
          issue({
            id: seriesId,
            seriesName: ghost ? "Ghost Rider" : "Action Comics",
            coverYear: seriesId === "gr2" ? 1992 : 1986,
            publisher: ghost ? "Marvel" : "DC",
          }),
        ];
      },
    });
    const action = await resolveCover(
      query({ series: "Action Comics, Vol. 1", issueNo: "1", coverYear: 1986, publisher: "DC", barcode: null }),
      client,
    );
    expect(action).toMatchObject({ status: "matched", via: "series", issue: { id: "ac1" } });
    expect(asked[0]).toEqual({ name: "Action Comics", volume: 1, yearBegan: null });
    expect(asked.some((row) => /vol/i.test(row.name))).toBe(false);

    const ghost = await resolveCover(
      query({ series: "Ghost Rider, Vol. 2 (1990-1998)", issueNo: "1", coverYear: 1992, publisher: "Marvel", barcode: null }),
      client,
    );
    expect(ghost).toMatchObject({ status: "matched", via: "series", issue: { id: "gr2" } });
    expect(asked).toContainEqual({ name: "Ghost Rider", volume: 2, yearBegan: 1990 });
  });

  it("keeps Ewoks when the catalog title is longer, and tries The Ewoks when the short name misses", async () => {
    const longer = lookup({
      async searchSeries(name) {
        longer.calls.push(name);
        if (name === "Ewoks") return [series({ id: "long", name: "Star Wars: Ewoks", yearBegan: 1985, publisher: "Marvel" })];
        return [];
      },
      async issuesForSeries() {
        return [issue({ id: "ew1", seriesName: "Star Wars: Ewoks", coverYear: 1985, publisher: "Marvel" })];
      },
    });
    const fromSuffix = await resolveCover(query({ series: "Ewoks", publisher: "Marvel", coverYear: 1985, barcode: null }), longer);
    expect(fromSuffix).toMatchObject({ status: "matched", issue: { id: "ew1" } });
    expect(longer.calls).toEqual(["Ewoks"]);
    expect(
      narrowSeries(
        [
          series({ id: "exact", name: "The Ewoks", yearBegan: 1985, publisher: "Marvel" }),
          series({ id: "long", name: "Star Wars: Ewoks", yearBegan: 1985, publisher: "Marvel" }),
          series({ id: "saga", name: "Saga of the Swamp Thing", yearBegan: 1982, publisher: "DC" }),
        ],
        query({ series: "Ewoks", publisher: "Marvel", coverYear: 1985 }),
      ).map((hit) => hit.id),
    ).toEqual(["exact"]);

    const titled = lookup({
      async searchSeries(name) {
        titled.calls.push(name);
        if (name === "The Ewoks") return [series({ id: "the", name: "The Ewoks", yearBegan: 1985, publisher: "Marvel" })];
        return [];
      },
      async issuesForSeries() {
        return [issue({ id: "ew2", seriesName: "The Ewoks", coverYear: 1985, publisher: "Marvel" })];
      },
    });
    const fromThe = await resolveCover(query({ series: "Ewoks", publisher: "Marvel", coverYear: 1985, barcode: null }), titled);
    expect(fromThe).toMatchObject({ status: "matched", issue: { id: "ew2" } });
    expect(titled.calls).toEqual(["Ewoks", "The Ewoks"]);
  });

  it("breaks a shared barcode prefix with the full UPC and then the issue number", () => {
    const barcode = "70985300001100111";
    const comic = query({ series: "Spawn", issueNo: "1", coverYear: 1992, publisher: "Image", barcode });
    const full = (number: string) => `709853000011${number.padStart(3, "0")}11`;
    const hits = [
      issue({ id: "s1", seriesName: "Spawn", number: "1", coverYear: 1992, publisher: "Image", upc: full("1") }),
      issue({ id: "s22", seriesName: "Spawn", number: "22", coverYear: 1994, publisher: "Image", upc: full("22") }),
      issue({ id: "s23", seriesName: "Spawn", number: "23", coverYear: 1994, publisher: "Image", upc: full("23") }),
    ];
    expect(chooseIssue(hits, comic, "1", "barcode")).toMatchObject({ status: "matched", via: "barcode", issue: { id: "s1" } });

    const prefix = hits.map((hit) => ({ ...hit, upc: "709853000011" }));
    expect(chooseIssue(prefix, comic, "1", "barcode")).toMatchObject({ status: "matched", issue: { id: "s1" } });
    expect(
      chooseIssue(
        [
          issue({ id: "b1", seriesName: "BRZRKR", number: "1", coverYear: 2021, publisher: "Boom", upc: "793945000011" }),
          issue({ id: "b6", seriesName: "BRZRKR", number: "6", coverYear: 2021, publisher: "Boom", upc: "793945000011" }),
        ],
        query({ series: "BRZRKR", issueNo: "1", coverYear: 2021, publisher: "Boom", barcode: "79394500001100111" }),
        "1",
        "barcode",
      ),
    ).toMatchObject({ status: "matched", issue: { id: "b1" } });
    expect(
      chooseIssue(
        [
          issue({ id: "m1", seriesName: "The Maxx", number: "1", coverYear: 1993, publisher: "Image", upc: "709853000028" }),
          issue({ id: "m28", seriesName: "The Maxx", number: "28", coverYear: 1996, publisher: "Image", upc: "709853000028" }),
        ],
        query({ series: "The Maxx", issueNo: "1", coverYear: 1993, publisher: "Image", barcode: "70985300002800111" }),
        "1",
        "barcode",
      ),
    ).toMatchObject({ status: "matched", issue: { id: "m1" } });

    expect(
      chooseIssue(
        [
          issue({ id: "a", seriesName: "Spawn", number: "1", coverYear: 1992, publisher: "Image", upc: barcode }),
          issue({ id: "b", seriesName: "Spawn", number: "1", coverYear: 1992, publisher: "Image", upc: "709853000011" }),
        ],
        comic,
        "1",
        "barcode",
      ),
    ).toMatchObject({ status: "matched", issue: { id: "a" } });

    expect(
      chooseIssue(
        [
          issue({ id: "b2", seriesName: "BRZRKR", number: "2", coverYear: 2021, publisher: "Boom", upc: "793945000011" }),
          issue({ id: "b6", seriesName: "BRZRKR", number: "6", coverYear: 2021, publisher: "Boom", upc: "793945000011" }),
        ],
        query({ series: "BRZRKR", issueNo: "2A", issue: "2A", coverYear: 2021, publisher: "Boom", barcode: "79394500001100121" }),
        "2A",
        "barcode",
      ),
    ).toMatchObject({ status: "matched", issue: { id: "b2" } });

    expect(
      chooseIssue(
        [
          issue({ id: "b2", seriesName: "BRZRKR", number: "2", coverYear: 2021, publisher: "Boom", upc: "793945000011" }),
          issue({
            id: "b2a",
            seriesName: "BRZRKR",
            number: "2",
            coverYear: 2021,
            publisher: "Boom",
            upc: "793945000011",
            upcs: ["79394500001100121"],
            covers: [{ label: "Cover A", imageUrl: image, upc: "79394500001100121" }],
          }),
        ],
        query({ series: "BRZRKR", issueNo: "2A", issue: "2A", coverYear: 2021, publisher: "Boom", barcode: "79394500001100121" }),
        "2A",
        "barcode",
      ),
    ).toMatchObject({ status: "matched", issue: { id: "b2a", imageUrl: image } });
  });

  it("breaks a shared series on the issue number when every detail UPC is null", () => {
    const shared = (id: string, number: string, coverYear: number) =>
      issue({
        id,
        seriesId: "8",
        seriesName: "Spawn",
        number,
        coverYear,
        seriesYear: 1992,
        publisher: "Image",
        upc: null,
        upcs: [],
        detailFetched: true,
      });
    expect(
      chooseIssue(
        [shared("101", "1", 1992), shared("122", "22", 1994), shared("123", "23", 1994)],
        query({ series: "Spawn", issueNo: "1", coverYear: 1992, publisher: "Image", barcode: "70985300001100111" }),
        "1",
        "barcode",
      ),
    ).toMatchObject({ status: "matched", issue: { id: "101" } });

    expect(
      chooseIssue(
        [
          issue({ id: "b2", seriesId: "4", seriesName: "BRZRKR", number: "2", coverYear: 2021, publisher: "Boom", upc: null, upcs: [] }),
          issue({ id: "b4", seriesId: "4", seriesName: "BRZRKR", number: "4", coverYear: 2021, publisher: "Boom", upc: null, upcs: [] }),
        ],
        query({ series: "BRZRKR", issueNo: "2A", issue: "2A", coverYear: 2021, publisher: "Boom", barcode: "79394500001100121" }),
        "2A",
        "barcode",
      ),
    ).toMatchObject({ status: "matched", issue: { id: "b2" } });

    const yearGap = chooseIssue(
      [
        issue({ id: "old", seriesId: "1", seriesName: "Spawn", number: "1", coverYear: 1960, seriesYear: 1960, publisher: "Image", upc: null }),
        issue({ id: "other", seriesId: "9", seriesName: "King Spawn", number: "9", coverYear: 2021, seriesYear: 2021, publisher: "Image", upc: null }),
      ],
      query({ series: "Spawn", issueNo: "1", coverYear: 1992, publisher: "Image", barcode: "70985300001100111" }),
      "1",
      "barcode",
    );
    expect(yearGap.status).toBe("unmatched");
    if (yearGap.status === "unmatched") expect(yearGap.reason).toMatch(/years apart/);
  });

  it("keeps Ewoks when the cover date is missing and only the series year disagrees", () => {
    const shelf = query({ series: "Ewoks", issueNo: "1", coverYear: 1985, publisher: "Marvel", barcode: null });
    const exact = chooseIssue(
      [issue({ id: "ew", seriesName: "Ewoks", number: "1", coverYear: null, seriesYear: 2024, publisher: "Marvel" })],
      shelf,
      "1",
      "series",
    );
    expect(exact).toMatchObject({ status: "matched", issue: { id: "ew" } });
    if (exact.status === "matched") expect(exact.coverReview).toBeUndefined();

    const suffix = chooseIssue(
      [issue({ id: "sw", seriesName: "Star Wars: Ewoks", number: "1", coverYear: null, seriesYear: 2024, publisher: "Marvel" })],
      shelf,
      "1",
      "series",
    );
    expect(suffix).toMatchObject({ status: "matched", issue: { id: "sw" } });
    if (suffix.status === "matched") expect(suffix.coverReview).toBeUndefined();

    const weaker = chooseIssue(
      [issue({ id: "adv", seriesName: "Ewoks Adventures", number: "1", coverYear: null, seriesYear: 2024, publisher: "Marvel" })],
      shelf,
      "1",
      "series",
    );
    expect(weaker).toMatchObject({ status: "matched", issue: { id: "adv" } });
    if (weaker.status === "matched") expect(weaker.coverReview).toMatch(/cover date is missing/i);
  });

  it("scores a one-issue Special above the match line", async () => {
    const copy = query({ series: "Doom Force", issueNo: "1", coverYear: 1992, publisher: "DC", barcode: null });
    const candidate = {
      seriesName: "Doom Force Special",
      issueNo: "1",
      variant: null,
      coverYear: 1992,
      releaseYear: null,
      seriesYear: 1992,
      upc: null,
      publisher: "DC",
    };
    const plain = scoreCandidate(copy, candidate);
    expect(plain.score).toBe(69);
    expect(plain.auto).toBe(false);
    const boosted = scoreCandidate(copy, { ...candidate, oneIssue: true });
    expect(boosted.score).toBeGreaterThanOrEqual(75);
    expect(boosted.auto).toBe(true);

    const matched = await resolveCover(
      copy,
      lookup({
        async searchSeries(name) {
          if (name !== "Doom Force") return [];
          return [series({ id: "s", name: "Doom Force Special", yearBegan: 1992, publisher: "DC", issueCount: 1 })];
        },
        async issuesForSeries() {
          return [issue({ id: "df1", seriesId: "s", seriesName: "Doom Force Special", number: "1", coverYear: 1992, seriesYear: 1992, publisher: "DC" })];
        },
      }),
    );
    expect(matched).toMatchObject({ status: "matched", issue: { id: "df1" } });
    if (matched.status === "matched") expect(matched.score).toBeGreaterThanOrEqual(75);

    const longer = await resolveCover(
      copy,
      lookup({
        async searchSeries() {
          return [series({ id: "o", name: "Doom Force Special", yearBegan: 1992, publisher: "DC", issueCount: 12 })];
        },
        async issuesForSeries() {
          throw new Error("a longer series is not opened");
        },
      }),
    );
    expect(longer.status).toBe("unmatched");
  });

  it("matches Ewoks on the series year when the catalog store date is decades off, and logs both years when it still refuses", () => {
    const ewoks = issue({
      id: "ew",
      seriesName: "The Ewoks",
      coverYear: 1985,
      seriesYear: 1985,
      releaseYear: 2024,
      publisher: "Marvel",
    });
    expect(
      chooseIssue([ewoks], query({ series: "Ewoks", coverYear: 1985, releaseYear: null, publisher: "Marvel", barcode: null }), "1", "series"),
    ).toMatchObject({ status: "matched", issue: { id: "ew" } });

    const refused = chooseIssue(
      [ewoks],
      query({ series: "Ewoks", coverYear: null, releaseYear: 2024, publisher: "Marvel", barcode: null }),
      "1",
      "series",
    );
    expect(refused.status).toBe("unmatched");
    if (refused.status === "unmatched") {
      expect(refused.reason).toContain("39");
      expect(refused.reason).toContain("shelf release 2024");
      expect(refused.reason).toContain("catalog cover 1985");
      expect(refused.reason).toContain("catalog series 1985");
    }
  });

  it("keeps a one-issue Special and skips that title when the series is longer", () => {
    const special = series({ id: "s", name: "Doom Force Special", yearBegan: 1992, publisher: "DC", issueCount: 1 });
    const ongoing = series({ id: "o", name: "Doom Force Special", yearBegan: 1992, publisher: "DC", issueCount: 12 });
    const comic = query({ series: "Doom Force", publisher: "DC", coverYear: 1992, barcode: null });
    expect(narrowSeries([special], comic).map((hit) => hit.id)).toEqual(["s"]);
    expect(narrowSeries([ongoing], comic)).toEqual([]);
    expect(mapSeries({ id: 9, name: "Doom Force Special", issue_count: 1, year_began: 1992 })?.issueCount).toBe(1);
  });
});

describe("cover backfill", () => {
  it("keeps a hand-picked Metron id when the barcode would match a different issue", async () => {
    const saved: string[] = [];
    const client = lookup({
      async issuesByUpc() {
        throw new Error("a hand-picked link is not searched");
      },
      async searchSeries() {
        throw new Error("a hand-picked link is not searched");
      },
    });
    await backfillCovers({
      comics: [record({ manualMetronIssueId: "88", manualCoverImageUrl: image, barcode: "70985300001100111" })],
      lookup: client,
      fileExists: () => false,
      saveImage: async (hit) => {
        saved.push(hit.id);
        return "metron-88.jpg";
      },
      markMatched: async (_id, update) => {
        expect(update.metronIssueId).toBe("88");
      },
      markUnmatched: async () => {
        throw new Error("a hand-picked link is not replaced");
      },
    });
    expect(saved).toEqual(["88"]);
    expect(client.calls).toEqual([]);
  });

  it("downloads a matched cover once and skips it on the next run", async () => {
    const files = new Set<string>();
    const saved: string[] = [];
    const marked: Array<{ id: string; metronIssueId: string; coverFile: string | null; coverUrl: string | null; coverNote?: string | null; printing?: number | null }> = [];
    const calls: string[] = [];
    const comics = [record(), record({ id: "comic-2", coverStatus: "unmatched", series: "Planet Slammer", barcode: null })];
    const client = lookup({
      async issuesByUpc(upc) {
        calls.push(`upc:${upc}`);
        return [issue()];
      },
    });

    const first = await backfillCovers({
      comics,
      lookup: client,
      fileExists: (filename) => files.has(filename),
      saveImage: async (hit) => {
        saved.push(hit.id);
        files.add(`metron-${hit.id}.jpg`);
        return `metron-${hit.id}.jpg`;
      },
      markMatched: async (id, update) => {
        marked.push({ id, ...update });
      },
      markUnmatched: async () => {
        throw new Error("should not unmatch");
      },
    });

    expect(first).toMatchObject({ pending: 1, matched: 1, unmatched: 0, skipped: 1, stoppedReason: null });
    expect(marked).toEqual([
      { id: "comic-1", metronIssueId: "50", coverFile: "metron-50.jpg", coverUrl: "/covers/files/metron-50.jpg" },
    ]);
    expect(saved).toEqual(["50"]);

    const second = await backfillCovers({
      comics: [{ ...comics[0], coverFile: "metron-50.jpg", coverStatus: "matched", metronIssueId: "50" }, comics[1]],
      lookup: client,
      fileExists: (filename) => files.has(filename),
      saveImage: async () => {
        throw new Error("should not download again");
      },
      markMatched: async () => {
        throw new Error("should not write again");
      },
      markUnmatched: async () => {
        throw new Error("should not unmatch");
      },
    });
    expect(second).toMatchObject({ pending: 0, matched: 0, skipped: 2 });
    expect(calls).toEqual(["upc:07596060000100001"]);
    expect(needsCover(comics[1], () => false)).toBe(false);
  });

  it("reads the matched Metron issue once and uses that image", async () => {
    const loaded: string[] = [];
    let seenUrl = "";
    const client = lookup({
      async issuesByUpc() {
        return [issue({ imageUrl: "https://static.metron.cloud/list.jpg" })];
      },
    });
    await backfillCovers({
      comics: [record()],
      lookup: client,
      fileExists: () => false,
      loadDetail: async (issueId) => {
        loaded.push(issueId);
        return {
          id: issueId,
          seriesId: "15",
          seriesName: "Saga",
          number: "1",
          imageUrl: "https://static.metron.cloud/detail.jpg",
          coverDate: null,
          coverYear: null,
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
          seriesYear: null,
          seriesVolume: null,
          metronIssueUrl: null,
          metronSeriesUrl: null,
          comicvineIssueId: null,
          comicvineSeriesId: null,
          gcdIssueId: null,
          gcdSeriesId: null,
        };
      },
      saveImage: async (hit) => {
        seenUrl = hit.imageUrl ?? "";
        return `metron-${hit.id}.jpg`;
      },
      markMatched: async () => undefined,
      markUnmatched: async () => {
        throw new Error("should not unmatch");
      },
    });
    expect(loaded).toEqual(["50"]);
    expect(seenUrl).toBe("https://static.metron.cloud/detail.jpg");
  });

  it("stops on the Metron budget without marking the current issue unmatched", async () => {
    const unmatched: string[] = [];
    const client = lookup({
      async issuesByUpc() {
        throw new MetronBudgetError("Metron daily limit reached (5000). Run again after the window resets.");
      },
    });
    const summary = await backfillCovers({
      comics: [record()],
      lookup: client,
      fileExists: () => false,
      saveImage: async () => "metron-50.jpg",
      markMatched: async () => undefined,
      markUnmatched: async (id) => {
        unmatched.push(id);
      },
    });
    expect(summary.stoppedReason).toMatch(/Metron paused until/);
    expect(summary.unmatched).toBe(0);
    expect(unmatched).toEqual([]);
  });

  it("resumes after the saved cursor instead of the first comic", async () => {
    const seen: string[] = [];
    const client = lookup();
    const summary = await backfillCovers({
      comics: [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })],
      cursorId: "a",
      lookup: client,
      fileExists: () => false,
      saveImage: async () => "metron-50.jpg",
      markMatched: async () => undefined,
      markUnmatched: async (id) => {
        seen.push(id);
      },
    });
    expect(seen).toEqual(["b", "c"]);
    expect(summary.pending).toBe(2);
    expect(client.calls.some((call) => call.startsWith("upc:"))).toBe(true);
  });

  it("pauses before the next issue and leaves it unmarked", async () => {
    const unmatched: string[] = [];
    const summary = await backfillCovers({
      comics: [record({ id: "a" }), record({ id: "b" })],
      lookup: lookup(),
      fileExists: () => false,
      saveImage: async () => "metron-50.jpg",
      markMatched: async () => undefined,
      markUnmatched: async (id) => {
        unmatched.push(id);
      },
      shouldPause: () => true,
    });
    expect(summary.stoppedReason).toBe("Paused.");
    expect(summary.matched).toBe(0);
    expect(unmatched).toEqual([]);
  });
});

describe("Metron rate limit", () => {
  afterEach(() => {
    clearMetronJobBudget();
    resetMetronCircuit();
    vi.restoreAllMocks();
  });

  it("spaces requests about 20 per minute and stops at 5000 per day", async () => {
    let time = 0;
    const waits: number[] = [];
    const { store, budget } = memoryStore();
    const limiter = new MetronLimiter(
      store,
      () => time,
      async (ms) => {
        waits.push(ms);
        time += ms;
      },
      () => "2026-10-13",
    );
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([METRON_MIN_INTERVAL_MS]);
    expect(budget.count).toBe(2);

    budget.count = METRON_DAILY_LIMIT;
    await expect(limiter.acquire()).rejects.toBeInstanceOf(MetronBudgetError);
  });

  it("leaves the interactive reserve usable after a background job stops", async () => {
    let time = 1_000_000;
    const { store } = memoryStore();
    const limiter = new MetronLimiter(
      store,
      () => time,
      async (ms) => {
        time += ms;
      },
      () => "2026-10-15",
    );
    let sent = 0;
    let reserve: unknown = null;
    for (let index = 0; index < METRON_FALLBACK_BURST; index += 1) {
      try {
        await limiter.acquire("background");
        sent += 1;
      } catch (error) {
        reserve = error;
        break;
      }
    }
    expect(sent).toBe(METRON_FALLBACK_BURST - METRON_INTERACTIVE_RESERVE - METRON_SAFETY_REMAINING);
    expect(reserve).toMatchObject({ pause: { budget: "Metron reserve" } });
    expect(limiter.snapshot().pausedUntil).toBeNull();
    await limiter.acquire("interactive");
    expect(limiter.snapshot().count).toBe(sent + 1);
  });

  it("backs off on 429 and sends basic auth", async () => {
    const logs: string[] = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      logs.push(input.message);
    });
    let time = 1_000_000;
    const waits: number[] = [];
    const { store } = memoryStore();
    const limiter = new MetronLimiter(
      store,
      () => time,
      async (ms) => {
        waits.push(ms);
        time += ms;
      },
      () => "2026-10-13",
    );
    const urls: string[] = [];
    let calls = 0;
    const transport: MetronTransport = {
      limiter,
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => time,
      fetch: async (url, init) => {
        calls += 1;
        urls.push(String(url));
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(basicAuthHeader("cody", "secret"));
        if (calls === 1) return new Response("slow", { status: 429, headers: { "retry-after": "30" } });
        return Response.json({
          results: [
            {
              id: 50,
              series: { id: 15, name: "Saga", year_began: 2012 },
              number: "1",
              issue: "Saga (2012) #1",
              cover_date: "2012-03-01",
              image: image,
            },
          ],
        });
      },
    };
    const hits = await createMetronCoverLookup(transport).issuesByUpc("07596060000100001");
    expect(hits).toEqual([
      issue({
        publisher: null,
        releaseYear: null,
        seriesYear: 2012,
        upc: null,
        variant: null,
        cvId: null,
        gcdId: null,
        storeDate: null,
        covers: [{ label: "Cover", imageUrl: image, upc: null }],
        upcs: [],
      }),
    ]);
    expect(urls[0]).toBe("https://metron.cloud/api/issue/?upc=07596060000100001");
    expect(waits).toContain(30_000);
    expect(calls).toBe(2);
    expect(logs).toContain("Metron rate limit, backing off 30000ms.");
  });

  it("reads the detail UPC when a shared-prefix list leaves it off", async () => {
    const cover = "https://static.metron.cloud/media/issue/spawn-1.jpg";
    const list = (id: number, number: string, coverDate: string) => ({
      id,
      series: { id: 8, name: "Spawn", volume: 1, year_began: 1992 },
      number,
      issue: `Spawn (1992) #${number}`,
      cover_date: coverDate,
      image: cover,
    });
    const urls: string[] = [];
    const { store } = memoryStore();
    const transport: MetronTransport = {
      limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-15"),
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => 0,
      fetch: async (url) => {
        const path = String(url);
        urls.push(path);
        if (path.includes("upc_starts_with=")) {
          return Response.json({
            results: [list(101, "1", "1992-05-01"), list(122, "22", "1994-08-01"), list(123, "23", "1994-09-01")],
          });
        }
        if (path.endsWith("/issue/101/")) {
          return Response.json({
            ...list(101, "1", "1992-05-01"),
            upc: "709853000011",
            variants: [{ name: "Cover A", image: cover, upc: "70985300001100111" }],
          });
        }
        if (path.endsWith("/issue/122/")) return Response.json({ ...list(122, "22", "1994-08-01"), upc: "70985300001102211" });
        if (path.endsWith("/issue/123/")) return Response.json({ ...list(123, "23", "1994-09-01"), upc: "70985300001102311" });
        return Response.json({ results: [] });
      },
    };
    const decision = await resolveCover(
      query({ series: "Spawn", issueNo: "1", coverYear: 1992, publisher: "Image", barcode: "70985300001100111" }),
      createMetronCoverLookup(transport),
    );
    expect(decision).toMatchObject({ status: "matched", via: "barcode", issue: { id: "101" } });
    expect(urls.some((url) => url.includes("/issue/?upc=70985300001100111"))).toBe(true);
    expect(urls.some((url) => url.includes("upc_starts_with=709853000011"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/issue/101/"))).toBe(true);

    const prefixOnly = await resolveCover(
      query({ series: "BRZRKR", issueNo: "2B", issue: "2B", coverYear: 2021, publisher: "Boom", barcode: "79394500001100211" }),
      lookup({
        async issuesByUpc() {
          return [];
        },
        async issuesByUpcPrefix() {
          return [
            issue({ id: "b2", seriesName: "BRZRKR", number: "2", coverYear: 2021, publisher: "Boom", upc: "793945000011" }),
            issue({ id: "b6", seriesName: "BRZRKR", number: "6", coverYear: 2021, publisher: "Boom", upc: "793945000011" }),
          ];
        },
      }),
    );
    expect(prefixOnly).toMatchObject({ status: "matched", issue: { id: "b2" } });
  });

  it("logs a Spawn #1 tie-break when detail UPCs are null and uses the issue number", async () => {
    const logs: string[] = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      logs.push(input.message);
    });
    const cover = "https://static.metron.cloud/media/issue/spawn-1.jpg";
    const list = (id: number, number: string, coverDate: string) => ({
      id,
      series: { id: 8, name: "Spawn", volume: 1, year_began: 1992 },
      number,
      issue: `Spawn (1992) #${number}`,
      cover_date: coverDate,
      image: cover,
    });
    const detail = (id: number, number: string, coverDate: string) => ({
      ...list(id, number, coverDate),
      upc: null,
      sku: "SEP920001",
      publisher: { name: "Image" },
      variants: [{ name: "Cover A", image: cover, sku: "SEP920001", upc: null }],
    });
    const urls: string[] = [];
    const { store } = memoryStore();
    const transport: MetronTransport = {
      limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-15"),
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => 0,
      fetch: async (url) => {
        const path = String(url);
        urls.push(path);
        if (path.includes("/issue/?upc=70985300001100111")) return Response.json({ results: [] });
        if (path.includes("upc_starts_with=")) {
          return Response.json({
            results: [list(101, "1", "1992-05-01"), list(122, "22", "1994-08-01"), list(123, "23", "1994-09-01")],
          });
        }
        if (path.endsWith("/issue/101/")) return Response.json(detail(101, "1", "1992-05-01"));
        if (path.endsWith("/issue/122/")) return Response.json(detail(122, "22", "1994-08-01"));
        if (path.endsWith("/issue/123/")) return Response.json(detail(123, "23", "1994-09-01"));
        return Response.json({ results: [] });
      },
    };
    const decision = await resolveCover(
      query({ series: "Spawn", issueNo: "1", coverYear: 1992, publisher: "Image", barcode: "70985300001100111" }),
      createMetronCoverLookup(transport),
    );
    expect(decision).toMatchObject({ status: "matched", via: "barcode", issue: { id: "101" } });
    expect(urls.filter((url) => url.endsWith("/issue/101/") || url.endsWith("/issue/122/") || url.endsWith("/issue/123/"))).toHaveLength(3);
    const line = logs.find((message) => message.includes("detail fetches 3"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/tried 709853000011\./);
    expect(line).toMatch(/candidates 101, 122, 123/);
    expect(line).toMatch(/101 number=1 upc=null variantUpcs=null/);
    expect(line).toMatch(/122 number=22 upc=null variantUpcs=null/);
    expect(line).toMatch(/123 number=23 upc=null variantUpcs=null/);
    expect(line).toMatch(/decision matched 101/);
    const mapped = mapIssue(detail(101, "1", "1992-05-01"));
    expect(mapped?.upc).toBeNull();
    expect(mapped?.upcs).toEqual([]);
  });

  it("pauses a background lane on the first 429 instead of retrying inside the request", async () => {
    let calls = 0;
    const { store } = memoryStore();
    const limiter = new MetronLimiter(store, () => 1_000, async () => undefined, () => "2026-10-15");
    const transport: MetronTransport = {
      limiter,
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => 1_000,
      fetch: async () => {
        calls += 1;
        return new Response("slow", { status: 429, headers: { "retry-after": "30" } });
      },
    };
    await expect(runInLane("background", () => createMetronCoverLookup(transport).issuesByUpc("1"))).rejects.toMatchObject({
      pause: { budget: "Metron rate limit", resumeAt: 31_000 },
    });
    expect(calls).toBe(1);
    expect(limiter.snapshot().pausedUntil).toBe(31_000);
  });

  it("reads Expected available in N seconds when Retry-After is missing", async () => {
    let time = 0;
    const waits: number[] = [];
    const { store } = memoryStore();
    const limiter = new MetronLimiter(
      store,
      () => time,
      async (ms) => {
        waits.push(ms);
        time += ms;
      },
      () => "2026-10-13",
    );
    let calls = 0;
    const transport: MetronTransport = {
      limiter,
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => time,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response("Expected available in 15 seconds", { status: 429 });
        return Response.json({ results: [] });
      },
    };
    await createMetronCoverLookup(transport).issuesByUpc("75960620687200111");
    expect(waits).toContain(15_000);
    expect(calls).toBe(2);
  });

  it("shares one budget file across limiters", async () => {
    let time = 0;
    const waits: number[] = [];
    let disk: MetronBudget = emptyBudget();
    const store: BudgetStore = {
      read: () => ({ ...disk }),
      write: (next) => {
        disk = { ...next };
      },
    };
    const sleep = async (ms: number) => {
      waits.push(ms);
      time += ms;
    };
    const first = new MetronLimiter(store, () => time, sleep, () => "2026-10-13");
    const second = new MetronLimiter(store, () => time, sleep, () => "2026-10-13");
    await first.acquire();
    await second.acquire();
    expect(waits).toEqual([METRON_MIN_INTERVAL_MS]);
    expect(disk.count).toBe(2);
  });

  it("reads the sustained remaining header as an exhausted daily window", () => {
    const { store, budget } = memoryStore({ day: "2026-10-13", count: 3 });
    const limiter = new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-13");
    limiter.observe(new Headers({ "x-ratelimit-sustained-remaining": "0" }));
    expect(budget.count).toBe(METRON_DAILY_LIMIT);
  });

  it("maps series and issue payloads", () => {
    expect(mapSeries({ id: 1, series: "Amazing Spider-Man (1963)", year_began: 1963, publisher: { name: "Marvel" } })).toEqual({
      id: "1",
      name: "Amazing Spider-Man",
      yearBegan: 1963,
      yearEnd: null,
      volume: null,
      publisher: "Marvel",
      issueCount: null,
    });
    expect(mapSeries({ id: 2, series: "Ghost Rider (1990-1998)", year_began: 1990, year_end: 1998, volume: 2, publisher: "Marvel" })).toEqual({
      id: "2",
      name: "Ghost Rider",
      yearBegan: 1990,
      yearEnd: 1998,
      volume: 2,
      publisher: "Marvel",
      issueCount: null,
    });
    expect(mapIssue({ id: 50, number: "1", cover_date: "2012-03-01", image: "http://static.metron.cloud/a.jpg", series: { id: 15, name: "Saga" } })?.imageUrl).toBe(
      "https://static.metron.cloud/a.jpg",
    );
  });

  it("sends volume and year_began with the series name", async () => {
    const urls: string[] = [];
    const { store } = memoryStore();
    const transport: MetronTransport = {
      limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-13"),
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => 0,
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json({ results: [] });
      },
    };
    await createMetronCoverLookup(transport).searchSeries("Ghost Rider", { volume: 2, yearBegan: 1990 });
    expect(urls).toEqual(["https://metron.cloud/api/series/?name=Ghost+Rider&volume=2&year_began=1990"]);
  });

  it("yields a background job after 60 Metron requests and stays open when nothing armed it", async () => {
    const logs: string[] = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      logs.push(input.message);
    });
    let time = 0;
    const transport = (): MetronTransport => ({
      limiter: new MetronLimiter(
        memoryStore().store,
        () => time,
        async (ms) => {
          time += ms;
        },
        () => "2026-10-15",
      ),
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => time,
      fetch: async () => {
        time += 60_000;
        return Response.json({ results: [] });
      },
    });

    const open = createMetronCoverLookup(transport());
    for (let n = 0; n < METRON_JOB_LIMIT + 1; n += 1) await open.issuesByUpc(String(n));

    armMetronJobBudget();
    const limited = createMetronCoverLookup(transport());
    for (let n = 0; n < METRON_JOB_LIMIT; n += 1) await limited.issuesByUpc(String(n));
    await expect(limited.issuesByUpc("over")).rejects.toMatchObject({ pause: { budget: "Metron job", count: METRON_JOB_LIMIT } });
    expect(logs.some((message) => message.startsWith("Metron job budget reached after 60 requests. Yielding. Resumes at "))).toBe(true);
  });

  it("pauses every Metron call after 3 connect timeouts and does not retry the timed-out request", async () => {
    const logs: string[] = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      logs.push(input.message);
    });
    let calls = 0;
    const { store } = memoryStore();
    const transport: MetronTransport = {
      limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-15"),
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => 0,
      fetch: async () => {
        calls += 1;
        const cause = new Error("Connect Timeout Error");
        (cause as Error & { code: string }).code = "UND_ERR_CONNECT_TIMEOUT";
        const error = new TypeError("fetch failed");
        (error as TypeError & { cause: Error }).cause = cause;
        throw error;
      },
    };
    const lookup = createMetronCoverLookup(transport);
    await expect(lookup.issuesByUpc("1")).rejects.toThrow(/fetch failed/);
    await expect(lookup.issuesByUpc("2")).rejects.toThrow(/fetch failed/);
    await expect(lookup.issuesByUpc("3")).rejects.toMatchObject({ pause: { budget: "Metron connect", resumeAt: METRON_CIRCUIT_BASE_MS } });
    expect(calls).toBe(3);
    await expect(lookup.issuesByUpc("4")).rejects.toMatchObject({ pause: { budget: "Metron connect" } });
    expect(calls).toBe(3);
    expect(logs.some((message) => message.startsWith("Metron connect failed 3 times: fetch failed (UND_ERR_CONNECT_TIMEOUT). Pausing all Metron calls. Resumes at "))).toBe(true);
  });

  it("doubles the connect pause up to 2 hours and clears it after any response", async () => {
    const timeout = new TypeError("fetch failed");
    (timeout as TypeError & { cause: { code: string } }).cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
    let now = 1_000;
    const fail = () => recordMetronTransportFailure(timeout, now);
    await fail();
    await fail();
    recordMetronTransportSuccess(now);
    await fail();
    await fail();
    expect(readMetronCircuit().openUntil).toBe(0);

    await expect(fail()).rejects.toMatchObject({ pause: { resumeAt: now + METRON_CIRCUIT_BASE_MS } });
    expect(readMetronCircuit().pauseMs).toBe(METRON_CIRCUIT_BASE_MS * 2);

    now += METRON_CIRCUIT_BASE_MS;
    await fail();
    await fail();
    await expect(fail()).rejects.toMatchObject({ pause: { resumeAt: now + METRON_CIRCUIT_BASE_MS * 2 } });
    expect(readMetronCircuit().pauseMs).toBe(METRON_CIRCUIT_BASE_MS * 4);

    now = 5_000_000;
    recordMetronTransportSuccess(now);
    expect(readMetronCircuit()).toMatchObject({ failures: 0, openUntil: 0, pauseMs: METRON_CIRCUIT_BASE_MS });

    for (let pause = METRON_CIRCUIT_BASE_MS; pause < METRON_CIRCUIT_MAX_MS; pause *= 2) {
      await fail();
      await fail();
      await expect(fail()).rejects.toMatchObject({ pause: { resumeAt: now + pause } });
      now += pause;
    }
    expect(readMetronCircuit().pauseMs).toBe(METRON_CIRCUIT_MAX_MS);
    await fail();
    await fail();
    await expect(fail()).rejects.toMatchObject({ pause: { resumeAt: now + METRON_CIRCUIT_MAX_MS } });
    expect(readMetronCircuit().pauseMs).toBe(METRON_CIRCUIT_MAX_MS);
  });
});

describe("local covers", () => {
  it("allows served cover files and still allows https catalog images", () => {
    expect(safeImageUrl("/covers/files/metron-50.jpg")).toBe("/covers/files/metron-50.jpg");
    expect(safeImageUrl("/covers/files/../metron-budget.json")).toBeNull();
    expect(safeImageUrl("https://static.metron.cloud/a.jpg")).toBe("https://static.metron.cloud/a.jpg");
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
  });

  it("shows the earliest real cover on a series card", () => {
    const cards = groupSeries([
      shelf({ id: "a", issueNo: "1", issueSort: 1, coverUrl: null }),
      shelf({ id: "b", issueNo: "2", issueSort: 2, coverUrl: "/covers/files/metron-50.jpg" }),
    ]);
    expect(cards[0]?.coverUrl).toBe("/covers/files/metron-50.jpg");
    expect(cards[0]?.sampleIssue).toBe("2");
  });

  it("counts duplicate copies as one comic and summed copies", () => {
    const cards = groupSeries([
      shelf({ id: "a", issueNo: "1", variant: "A", variantDescription: "Cover A", quantity: 1, keyLevel: "Major" }),
      shelf({ id: "b", issueNo: "1A", variantDescription: "Cover A", quantity: 2, keyLevel: "Major" }),
      shelf({ id: "c", issueNo: "1", variant: "A", variantDescription: "Second printing", keyLevel: "Minor" }),
    ]);
    expect(cards[0]).toMatchObject({ count: 2, copies: 4, keys: 2, keyLevel: "Major" });
    expect(seriesCardCountLabel({ count: 2, copies: 4 })).toBe("2 comics · 4 copies");
    expect(seriesCardCountLabel({ count: 1, copies: 1 })).toBe("1 comic");
  });
});

function shelf(overrides: Partial<ShelfComic>): ShelfComic {
  return {
    id: "1",
    series: "Saga",
    publisher: "Image",
    coreSeriesId: "50001",
    issueNo: "1",
    issueSort: 1,
    quantity: 1,
    keyLevel: null,
    rawOrSlabbed: null,
    coverUrl: null,
    variant: null,
    grade: null,
    storageBox: null,
    read: false,
    ...overrides,
  };
}
