import { afterEach, describe, expect, it } from "vitest";
import { parseGcdIssue } from "@/lib/catalog/gcd";
import { matchHitFromIssue } from "@/lib/catalog/match-hits";
import { backfillCovers } from "@/lib/covers/backfill";
import { classifyCrossNameHits, crossCollectedQuery, crossForeignFromComicVine, crossLinkLine, crossNameQuery, lookupCrossIssue, type CrossForeign, type CrossLookup } from "@/lib/covers/cross-link";
import { crossMissKey, setCrossMissCacheForTests, type CrossMissCache, type StoredCrossMiss } from "@/lib/covers/cross-miss";
import { emptyBudget, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import { clearMetronDetailCache, metronIssueQuery, metronIssuesByCrossId, metronIssuesByNameOnce, type MetronTransport } from "@/lib/covers/metron-client";
import { resetMetronCircuit } from "@/lib/covers/metron-circuit";
import type { CoverLookup, CoverRecord, MetronIssueHit } from "@/lib/covers/types";

const image = "https://static.metron.cloud/media/issue/get-along-gang.jpg";
const barcode = "012345678905";

afterEach(() => {
  setCrossMissCacheForTests(null);
  resetMetronCircuit();
  clearMetronDetailCache();
});

function hit(overrides: Partial<MetronIssueHit> = {}): MetronIssueHit {
  return {
    id: "90",
    seriesId: "40",
    seriesName: "Get Along Gang",
    number: "1",
    coverYear: 1985,
    imageUrl: image,
    label: null,
    seriesYear: 1985,
    ...overrides,
  };
}

function record(overrides: Partial<CrossForeign> = {}): CrossForeign {
  return { seriesName: "Get Along Gang, Vol. 1 (1985 series)", number: "1", seriesYear: null, barcode: null, ...overrides };
}

function copy(overrides: Partial<CoverRecord> = {}): CoverRecord {
  return {
    id: "comic-1",
    series: "Get Along Gang",
    issueNo: "1",
    issue: "1",
    coverYear: 1985,
    barcode: null,
    variant: null,
    publisher: "Marvel",
    coverFile: null,
    coverStatus: null,
    metronIssueId: null,
    ...overrides,
  };
}

function memoryCache(): { cache: CrossMissCache; rows: Map<string, StoredCrossMiss> } {
  const rows = new Map<string, StoredCrossMiss>();
  return {
    rows,
    cache: {
      async read(key) {
        return rows.get(key) ?? null;
      },
      async write(key, row) {
        rows.set(key, row);
      },
    },
  };
}

function transport(fetchImpl: MetronTransport["fetch"]): MetronTransport {
  const budget: MetronBudget = { ...emptyBudget(), day: "2026-10-16" };
  const store: BudgetStore = { read: () => ({ ...budget }), write: (next) => Object.assign(budget, next) };
  return {
    limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-16"),
    username: "cody",
    password: "saved-token",
    baseUrl: "https://metron.cloud/api",
    now: () => 0,
    fetch: fetchImpl,
  };
}

function gangLookup(fetchImpl: MetronTransport["fetch"], foreign: CrossForeign = record()): CrossLookup {
  const client = transport(fetchImpl);
  return {
    byComicVine: (id) => metronIssuesByCrossId(client, "cv_id", id),
    byGcd: (id) => metronIssuesByCrossId(client, "gcd_id", id),
    foreignIssue: async () => foreign,
    byName: (query) => metronIssuesByNameOnce(client, query.name, query.number, query.year),
  };
}

describe("name fallback after an empty cross-id", () => {
  it("reads the GCD series year and strips the volume before the query", () => {
    const parsed = parseGcdIssue({
      api_url: "https://www.comics.org/api/issue/210623/",
      series_name: "Get Along Gang, Vol. 1 (1985 series)",
      number: "1",
      barcode,
    });
    expect(parsed?.id).toBe("210623");
    expect(parsed?.seriesYear).toBe(1985);
    expect(crossNameQuery({ seriesName: parsed?.seriesName ?? "", number: "1", seriesYear: parsed?.seriesYear ?? null, barcode })).toEqual({
      name: "Get Along Gang",
      number: "1",
      year: 1985,
    });
    expect(crossForeignFromComicVine({ issue_number: "1", volume: { id: 12, name: "Saga, Vol. 1", start_year: 2012 } })).toMatchObject({
      seriesName: "Saga, Vol. 1",
      number: "1",
      seriesYear: 2012,
      volumeId: "12",
    });
    expect(crossNameQuery({ seriesName: "Saga, Vol. 1", number: "1", seriesYear: 2012, barcode: null }).name).toBe("Saga");
  });

  it("asks Metron once by the stripped GCD name, number, and series year", async () => {
    const urls: string[] = [];
    const decision = await lookupCrossIssue(
      { id: "1", series: "Get Along Gang", issueNo: "1", issue: "1", metronIssueId: null, gcdIssueId: "210623", barcode },
      gangLookup(async (url) => {
        urls.push(String(url));
        const text = String(url);
        if (text.includes("gcd_id=")) return Response.json({ results: [] });
        return Response.json({
          results: [{ id: 90, number: "1", image, series: { id: 40, name: "Get Along Gang", year_began: 1985 }, upc: barcode }],
        });
      }),
    );
    expect(urls).toEqual([
      "https://metron.cloud/api/issue/?gcd_id=210623",
      "https://metron.cloud/api/issue/?series_name=Get+Along+Gang&number=1&series_year_began=1985",
    ]);
    expect(urls.join(" ")).not.toMatch(/volume=|alt_number|series_q/);
    expect(decision).toMatchObject({ status: "linked", hit: { id: "90" } });
  });

  it("does not spend alt_number when the follow-up number is three digits", async () => {
    const urls: string[] = [];
    await lookupCrossIssue(
      { id: "1", series: "Captain America", issueNo: "783", issue: "783", metronIssueId: null, gcdIssueId: "210623" },
      gangLookup(async (url) => {
        urls.push(String(url));
        return Response.json({ results: [] });
      }, { seriesName: "Captain America", number: "783", seriesYear: 2023, barcode: null }),
    );
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("number=783");
    expect(urls[1]).toContain("series_year_began=2023");
    expect(urls.join(" ")).not.toMatch(/alt_number|series_q/);
  });

  it("links a barcode match and a single exact name, number, and year", () => {
    const barcoded = classifyCrossNameHits({
      via: "gcd_id",
      foreignId: "210623",
      record: record({ barcode }),
      hits: [hit({ id: "91", seriesName: "Other Gang", upc: "999999999999" }), hit({ id: "90", upc: barcode })],
    });
    expect(barcoded).toMatchObject({ status: "linked", hit: { id: "90" } });
    const exact = classifyCrossNameHits({
      via: "gcd_id",
      foreignId: "210623",
      record: record({ seriesYear: 1985 }),
      hits: [hit()],
    });
    expect(exact).toMatchObject({ status: "linked", hit: { id: "90" } });
  });

  it("keeps several hits, a year mismatch, and an empty search unlinked", () => {
    const many = classifyCrossNameHits({
      via: "gcd_id",
      foreignId: "210623",
      record: record({ seriesYear: 1985 }),
      hits: [hit(), hit({ id: "91" })],
    });
    expect(many.status).toBe("candidates");
    if (many.status === "candidates") {
      expect(many.reason).toBe("Metron has no GCD cross-link; searched by name: 2 candidates");
      expect(many.hits.map((item) => item.id)).toEqual(["90", "91"]);
      expect(crossLinkLine({ id: "1", series: "Get Along Gang", issueNo: "1", issue: "1", metronIssueId: null }, many)).toBe(
        "Get Along Gang #1: Metron has no GCD cross-link; searched by name: 2 candidates",
      );
      expect(many.hits.map(matchHitFromIssue).map((item) => item?.id)).toEqual(["90", "91"]);
    }
    const wrongYear = classifyCrossNameHits({
      via: "gcd_id",
      foreignId: "210623",
      record: record({ seriesYear: 1985 }),
      hits: [hit({ seriesYear: 1990 })],
    });
    expect(wrongYear).toMatchObject({ status: "candidates", reason: "Metron has no GCD cross-link; searched by name: 1 candidates" });
    const none = classifyCrossNameHits({ via: "cv_id", foreignId: "400", record: record(), hits: [] });
    expect(none).toMatchObject({ status: "miss", reason: "not on Metron", nameSearched: true });
  });

  it("uses the Comic Vine record the same way after cv_id is empty", async () => {
    const names: string[] = [];
    const decision = await lookupCrossIssue(
      { id: "1", series: "Saga", issueNo: "1", issue: "1", metronIssueId: null, comicvineIssueId: "400" },
      {
        byComicVine: async () => [],
        byGcd: async () => {
          throw new Error("gcd should wait");
        },
        foreignIssue: async (via) => {
          expect(via).toBe("cv_id");
          return { seriesName: "Saga (2012)", number: "1", seriesYear: null, barcode: null };
        },
        byName: async (query) => {
          names.push(`${query.name}|${query.number}|${query.year}`);
          return [hit({ seriesName: "Saga", seriesYear: 2012 }), hit({ id: "91", seriesName: "Saga", seriesYear: 2012 })];
        },
      },
    );
    expect(names).toEqual(["Saga|1|2012"]);
    expect(decision).toMatchObject({ status: "candidates", reason: "Metron has no Comic Vine cross-link; searched by name: 2 candidates" });
  });

  it("searches the GCD record once when both id filters are empty", async () => {
    const vias: string[] = [];
    let nameCalls = 0;
    const decision = await lookupCrossIssue(
      { id: "1", series: "Get Along Gang", issueNo: "1", issue: "1", metronIssueId: null, comicvineIssueId: "400", gcdIssueId: "210623" },
      {
        byComicVine: async () => [],
        byGcd: async () => [],
        foreignIssue: async (via) => {
          vias.push(via);
          return record({ seriesYear: 1985 });
        },
        byName: async () => {
          nameCalls += 1;
          return [];
        },
      },
    );
    expect(vias).toEqual(["gcd_id"]);
    expect(nameCalls).toBe(1);
    expect(decision).toMatchObject({ status: "miss", reason: "not on Metron" });
    expect(crossLinkLine({ id: "1", series: "Get Along Gang", issueNo: "1", issue: "1", metronIssueId: null }, decision)).toBe("Get Along Gang #1: not on Metron");
  });

  it("asks for the Trade Paperback series when a GCD trade id has no Metron cross-link", async () => {
    const queries: Array<{ name: string; number: string; seriesType?: string | null }> = [];
    const decision = await lookupCrossIssue(
      {
        id: "god",
        series: "God Country",
        issueNo: "TP-A",
        issue: "TP-A",
        shelfFormat: "tp",
        metronIssueId: null,
        gcdIssueId: "2113149",
      },
      {
        byComicVine: async () => [],
        byGcd: async () => [],
        foreignIssue: async () => ({ seriesName: "God Country", number: "1", seriesYear: 2017, barcode: null }),
        byName: async (query) => {
          queries.push(query);
          return [];
        },
      },
    );
    expect(crossCollectedQuery({ shelfFormat: "tp", issueNo: "TP-A", issue: "TP-A" }, { seriesName: "God Country", number: "[nn]", seriesYear: 2017, barcode: null })).toMatchObject({
      name: "God Country",
      number: "1",
      seriesType: "Trade Paperback",
    });
    expect(queries[0]).toMatchObject({ name: "God Country", number: "1", seriesType: "Trade Paperback" });
    expect(metronIssueQuery("God Country", "1", 2017, "primary", null, "Trade Paperback")).toBe(
      "/issue/?series_name=God+Country&number=1&series_year_began=2017&series_type=Trade+Paperback",
    );
    expect(decision.status).toBe("miss");
  });

  it("caches a miss for seven days and skips Metron on the next lookup", async () => {
    const store = memoryCache();
    setCrossMissCacheForTests(store.cache);
    let calls = 0;
    const lookup: CrossLookup = {
      byComicVine: async () => [],
      byGcd: async () => {
        calls += 1;
        return [];
      },
      foreignIssue: async () => record({ seriesYear: 1985 }),
      byName: async () => {
        calls += 1;
        return [hit(), hit({ id: "91", seriesYear: 1990 })];
      },
    };
    const shelf = { id: "1", series: "Get Along Gang", issueNo: "1", issue: "1", metronIssueId: null, gcdIssueId: "210623" };
    const first = await lookupCrossIssue(shelf, lookup);
    expect(first.status).toBe("candidates");
    expect(calls).toBe(2);
    const second = await lookupCrossIssue(shelf, lookup);
    expect(second).toMatchObject({ status: "candidates", reason: "Metron has no GCD cross-link; searched by name: 2 candidates" });
    expect(calls).toBe(2);
    const key = crossMissKey(null, "210623");
    const stale = store.rows.get(key);
    expect(stale?.hits).toHaveLength(2);
    store.rows.set(key, { ...stale!, fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() });
    await lookupCrossIssue(shelf, lookup);
    expect(calls).toBe(4);
  });

  it("does not cache a lookup that never reached Metron", async () => {
    const store = memoryCache();
    setCrossMissCacheForTests(store.cache);
    let tries = 0;
    const lookup: CrossLookup = {
      byComicVine: async () => [],
      byGcd: async () => [],
      foreignIssue: async () => {
        tries += 1;
        throw new Error("GCD is down");
      },
      byName: async () => {
        throw new Error("name search should wait");
      },
    };
    const shelf = { id: "1", series: "Get Along Gang", issueNo: "1", issue: "1", metronIssueId: null, gcdIssueId: "210623" };
    expect(await lookupCrossIssue(shelf, lookup)).toMatchObject({ status: "miss", reason: "not on Metron", nameSearched: false });
    expect(await lookupCrossIssue(shelf, lookup)).toMatchObject({ nameSearched: false });
    expect(tries).toBe(2);
    expect(store.rows.size).toBe(0);
  });
});

describe("backfill stops after the one name query", () => {
  function lookup(byName: CrossLookup["byName"]): { cross: CrossLookup; names: number } {
    const state = { names: 0 };
    return {
      names: 0,
      cross: {
        byComicVine: async () => [],
        byGcd: async () => [],
        foreignIssue: async () => record({ seriesYear: 1985 }),
        byName: async (query) => {
          state.names += 1;
          return byName ? byName(query) : [];
        },
      },
    };
  }

  const quiet: CoverLookup = {
    async issuesByUpc() {
      throw new Error("barcode search should wait");
    },
    async issuesByUpcPrefix() {
      return [];
    },
    async searchSeries() {
      throw new Error("another name search should wait");
    },
    async issuesForSeries() {
      return [];
    },
    async issuesByName() {
      throw new Error("another name search should wait");
    },
  };

  it("shows candidates without linking them", async () => {
    const reasons: string[] = [];
    const wired = lookup(async () => [hit(), hit({ id: "91" })]);
    const summary = await backfillCovers({
      comics: [copy({ comicvineIssueId: "400" })],
      lookup: quiet,
      fileExists: () => false,
      saveImage: async () => {
        throw new Error("should not download");
      },
      markMatched: async () => {
        throw new Error("should not link");
      },
      markUnmatched: async (_id, reason) => {
        reasons.push(reason);
      },
      crossLookup: wired.cross,
    });
    expect(summary.unmatched).toBe(1);
    expect(summary.matched).toBe(0);
    expect(reasons).toEqual(["Metron has no Comic Vine cross-link; searched by name: 2 candidates"]);
  });

  it("links the one exact hit and does not search again", async () => {
    const marked: string[] = [];
    const wired = lookup(async () => [hit({ upc: barcode })]);
    const summary = await backfillCovers({
      comics: [copy({ comicvineIssueId: "400", barcode })],
      lookup: quiet,
      fileExists: () => false,
      saveImage: async (issue) => `metron-${issue.id}.jpg`,
      markMatched: async (_id, update) => {
        marked.push(update.metronIssueId);
      },
      markUnmatched: async () => {
        throw new Error("should link");
      },
      crossLookup: wired.cross,
    });
    expect(summary.matched).toBe(1);
    expect(marked).toEqual(["90"]);
  });

  it("records an empty name search as not on Metron", async () => {
    const reasons: string[] = [];
    const wired = lookup(async () => []);
    const summary = await backfillCovers({
      comics: [copy({ comicvineIssueId: "400" })],
      lookup: quiet,
      fileExists: () => false,
      saveImage: async () => {
        throw new Error("should not download");
      },
      markMatched: async () => {
        throw new Error("should not link");
      },
      markUnmatched: async (_id, reason) => {
        reasons.push(reason);
      },
      crossLookup: {
        ...wired.cross,
        foreignIssue: async (via) => {
          expect(via).toBe("cv_id");
          return { seriesName: "Saga", number: "1", seriesYear: 2012, barcode: null };
        },
      },
    });
    expect(summary.unmatched).toBe(1);
    expect(reasons).toEqual(["not on Metron"]);
  });
});
