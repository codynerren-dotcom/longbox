import { describe, expect, it } from "vitest";
import { parseGcdSeriesRun } from "@/lib/catalog/gcd";
import { parseComicVineIssueCount } from "@/lib/catalog/match-search";
import { emptyBudget, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import { fetchMetronSeriesRun, metronSeriesRunLabel, readMetronIssueCount, selectMetronSeriesRun, type MetronTransport } from "@/lib/covers/metron-client";
import { resolveSeriesRun, SERIES_RUN_MAX_AGE_MS, seriesRunCacheKey, seriesRunIdentity, type SeriesRunCache } from "@/lib/series-run";

const DAY = 24 * 60 * 60 * 1000;

function memoryCache(seed: Record<string, { numbers: string[]; issueCount: number | null; fetchedAt: string }> = {}): SeriesRunCache & {
  rows: Map<string, { numbers: string[]; issueCount: number | null; fetchedAt: string }>;
} {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    async read(key) {
      return rows.get(key) ?? null;
    },
    async write(key, row) {
      rows.set(key, row);
    },
  };
}

function transport(handler: (url: string) => unknown): MetronTransport {
  const budget: MetronBudget = emptyBudget();
  const store: BudgetStore = { read: () => budget, write: (next) => Object.assign(budget, next) };
  return {
    limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-14"),
    username: "cody",
    password: "secret",
    baseUrl: "https://metron.cloud/api",
    now: () => 0,
    fetch: async (url) => Response.json(handler(String(url))),
  };
}

describe("series run cache", () => {
  it("reuses a Metron run for a week and refreshes after that", async () => {
    const now = Date.parse("2026-10-14T00:00:00.000Z");
    const key = seriesRunCacheKey("metron", "15");
    const cache = memoryCache({
      [key]: { numbers: ["1", "2", "3"], issueCount: 3, fetchedAt: new Date(now - 6 * DAY).toISOString() },
    });
    let loads = 0;
    const fresh = await resolveSeriesRun(
      { metronSeriesId: "15", gcdSeriesId: "9", comicvineSeriesId: "7" },
      {
        cache,
        now: () => now,
        loadMetron: async () => {
          loads += 1;
          return { numbers: ["1"], issueCount: 1 };
        },
        loadGcd: async () => {
          throw new Error("gcd should wait");
        },
      },
    );
    expect(fresh).toEqual({ numbers: ["1", "2", "3"], issueCount: 3 });
    expect(loads).toBe(0);

    cache.rows.set(key, { numbers: ["1", "2", "3"], issueCount: 3, fetchedAt: new Date(now - 8 * DAY).toISOString() });
    const refreshed = await resolveSeriesRun(
      { metronSeriesId: "15", gcdSeriesId: null, comicvineSeriesId: null },
      {
        cache,
        now: () => now,
        loadMetron: async () => {
          loads += 1;
          return { numbers: ["1", "2", "3", "4", "5"], issueCount: 8 };
        },
      },
    );
    expect(loads).toBe(1);
    expect(refreshed).toEqual({ numbers: ["1", "2", "3", "4", "5"], issueCount: 8 });
    expect(cache.rows.get(key)?.fetchedAt).toBe(new Date(now).toISOString());
    expect(SERIES_RUN_MAX_AGE_MS).toBe(7 * DAY);
  });

  it("keeps a stale run when the refresh fails and prefers Metron over later catalogs", async () => {
    const now = Date.parse("2026-10-14T00:00:00.000Z");
    const key = seriesRunCacheKey("metron", "15");
    const fetchedAt = new Date(now - 8 * DAY).toISOString();
    const cache = memoryCache({ [key]: { numbers: ["1", "2"], issueCount: 2, fetchedAt } });
    let gcdLoads = 0;
    const kept = await resolveSeriesRun(
      { metronSeriesId: "15", gcdSeriesId: "90", comicvineSeriesId: "70" },
      {
        cache,
        now: () => now,
        loadMetron: async () => {
          throw new Error("metron down");
        },
        loadGcd: async () => {
          gcdLoads += 1;
          return { numbers: ["9"], issueCount: 9 };
        },
      },
    );
    expect(kept).toEqual({ numbers: ["1", "2"], issueCount: 2 });
    expect(cache.rows.get(key)?.fetchedAt).toBe(fetchedAt);
    expect(gcdLoads).toBe(0);

    const fallback = await resolveSeriesRun(
      { metronSeriesId: "15", gcdSeriesId: "90", comicvineSeriesId: "70" },
      {
        cache: memoryCache(),
        now: () => now,
        loadMetron: async () => null,
        loadGcd: async () => ({ numbers: ["1", "Annual 1"], issueCount: 4 }),
        loadComicVine: async () => {
          throw new Error("comic vine should wait");
        },
      },
    );
    expect(fallback).toEqual({ numbers: ["1", "Annual 1"], issueCount: 4 });

    const counted = await resolveSeriesRun(
      { metronSeriesId: null, gcdSeriesId: null, comicvineSeriesId: "70" },
      {
        cache: memoryCache(),
        now: () => now,
        loadComicVine: async () => ({ numbers: [], issueCount: 6 }),
      },
    );
    expect(counted).toEqual({ numbers: [], issueCount: 6 });
    expect(seriesRunIdentity([{ metronSeriesId: "15" }, { metronSeriesId: "15" }, { metronSeriesId: "4", gcdSeriesId: "0" }])).toEqual({
      metronSeriesId: "15",
      gcdSeriesId: null,
      comicvineSeriesId: null,
    });
  });
});

describe("catalog series payloads", () => {
  it("reads a Metron issue list and falls back to issue_count when the list is cut off", async () => {
    expect(readMetronIssueCount({ issue_count: 72 })).toBe(72);
    expect(selectMetronSeriesRun({ numbers: ["1", "1", "2"], issueCount: 40, complete: true })).toEqual({
      numbers: ["1", "2"],
      issueCount: 40,
    });
    expect(selectMetronSeriesRun({ numbers: ["1", "2"], issueCount: 40, complete: false })).toEqual({
      numbers: [],
      issueCount: 40,
    });

    const urls: string[] = [];
    const run = await fetchMetronSeriesRun(
      transport((url) => {
        urls.push(url);
        if (url.endsWith("/series/15/")) return { id: 15, issue_count: 4 };
        if (url.includes("page=2")) {
          return { next: null, results: [{ number: "01" }, { number: "3" }, { number: "Annual 1" }] };
        }
        return { next: "https://metron.cloud/api/issue/?series_id=15&page=2", results: [{ number: "1" }, { number: "2" }] };
      }),
      "15",
    );
    expect(urls[0]).toBe("https://metron.cloud/api/series/15/");
    expect(run).toEqual({ numbers: ["1", "2", "3", "Annual 1"], issueCount: 4 });
    expect(urls.join(" ")).not.toContain("secret");
  });

  it("parses GCD descriptors and a Comic Vine issue count", () => {
    expect(
      parseGcdSeriesRun({
        issue_descriptors: ["1", "01", "2", "Annual 1"],
        issue_count: 10,
      }),
    ).toEqual({ numbers: ["1", "2", "Annual 1"], issueCount: 10 });
    expect(parseGcdSeriesRun({ issue_count: "8" })).toEqual({ numbers: [], issueCount: 8 });
    expect(parseGcdSeriesRun({ name: "Saga" })).toBeNull();
    expect(parseComicVineIssueCount({ count_of_issues: 54 })).toBe(54);
    expect(parseComicVineIssueCount({ count_of_issues: 0 })).toBeNull();

    const genies = eightBillionGeniesDescriptors();
    expect(parseGcdSeriesRun({ issue_descriptors: genies, issue_count: 40 })).toEqual({
      numbers: ["1", "2", "3", "4", "5", "6", "7", "8"],
      issueCount: 8,
    });
    expect(selectMetronSeriesRun({ numbers: genies, issueCount: 40, complete: true })).toEqual({
      numbers: ["1", "2", "3", "4", "5", "6", "7", "8"],
      issueCount: 8,
    });
    expect(metronSeriesRunLabel({ number: "7", variant: "Bird City Comics Store Variant" })).toBe("7 [variant]");
    expect(metronSeriesRunLabel({ number: "1K" })).toBe("1K");
    expect(metronSeriesRunLabel({ number: "2", variant_of: 99 })).toBe("2 [variant]");
  });
});

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
