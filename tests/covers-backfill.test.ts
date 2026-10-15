import { describe, expect, it } from "vitest";
import { groupSeries, type ShelfComic } from "@/lib/collection";
import { backfillCovers, needsCover } from "@/lib/covers/backfill";
import { emptyBudget, METRON_DAILY_LIMIT, METRON_MIN_INTERVAL_MS, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import { chooseIssue, narrowSeries, resolveCover } from "@/lib/covers/match";
import { basicAuthHeader, createMetronCoverLookup, mapIssue, mapSeries, type MetronTransport } from "@/lib/covers/metron-client";
import { MetronBudgetError, type CoverLookup, type CoverQuery, type CoverRecord, type MetronIssueHit, type MetronSeriesHit } from "@/lib/covers/types";
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
});

describe("cover backfill", () => {
  it("downloads a matched cover once and skips it on the next run", async () => {
    const files = new Set<string>();
    const saved: string[] = [];
    const marked: Array<{ id: string; metronIssueId: string; coverFile: string; coverUrl: string }> = [];
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
    expect(summary.stoppedReason).toMatch(/daily limit/);
    expect(summary.unmatched).toBe(0);
    expect(unmatched).toEqual([]);
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

  it("backs off on 429 and sends basic auth", async () => {
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
        covers: [{ label: "Cover", imageUrl: image }],
      }),
    ]);
    expect(urls[0]).toBe("https://metron.cloud/api/issue/?upc=07596060000100001");
    expect(waits).toContain(30_000);
    expect(calls).toBe(2);
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
    let disk: MetronBudget = { day: "", count: 0, lastRequestAt: null };
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
      publisher: "Marvel",
    });
    expect(mapIssue({ id: 50, number: "1", cover_date: "2012-03-01", image: "http://static.metron.cloud/a.jpg", series: { id: 15, name: "Saga" } })?.imageUrl).toBe(
      "https://static.metron.cloud/a.jpg",
    );
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
