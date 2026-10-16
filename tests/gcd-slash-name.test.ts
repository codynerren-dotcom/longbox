import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGcdCatalog,
  GCD_RESPONSE_MAX_AGE_MS,
  parseGcdIssue,
  parseGcdSeries,
  resetGcdBudget,
  setGcdResponseCacheForTests,
  type GcdCachedResponse,
  type GcdCatalog,
  type GcdIssueRow,
  type GcdResponseCache,
  type GcdSeriesRow,
} from "@/lib/catalog/gcd";
import {
  gcdSeriesNameKey,
  gcdSeriesNameQueries,
  gcdSeriesNameSegment,
  rankGcdSeries,
  shelfIsUsBook,
} from "@/lib/catalog/gcd-name";
import { emptyGcdRate, gcdUsage } from "@/lib/catalog/rate-limit";
import { searchGcdMatches } from "@/lib/covers/gcd-match";
import * as logWrite from "@/lib/log/write";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/gcd/batman-spawn.json", import.meta.url), "utf8")) as {
  page1: { results: unknown[]; next: string | null };
  page2: { results: unknown[]; next: string | null };
  page3: { results: unknown[]; next: string | null };
  empty: unknown;
  issue: unknown;
};

const query = "Batman / Spawn #1 2022";
const barcode = "76194137888600134";
const publishers: Record<string, string> = { "54": "DC", "200": "Panini Comics", "480": "Image" };

function rowsFrom(body: { results: unknown[] }): GcdSeriesRow[] {
  return body.results.map((row) => parseGcdSeries(row)).filter((row): row is GcdSeriesRow => row !== null);
}

function named(rows: GcdSeriesRow[]): GcdSeriesRow[] {
  return rows.map((row) => ({ ...row, publisher: row.publisher ?? (row.publisherId ? publishers[row.publisherId] ?? null : null) }));
}

describe("GCD series names that contain a slash", () => {
  afterEach(() => {
    resetGcdBudget();
    setGcdResponseCacheForTests(null);
    vi.restoreAllMocks();
    delete process.env.GCD_USERNAME;
    delete process.env.GCD_PASSWORD;
  });

  it("never puts a slash in the name path, and asks for the rare part plus the slash-removed title", () => {
    expect(gcdSeriesNameQueries("Batman / Spawn")).toEqual(["Spawn", "Batman Spawn"]);
    expect(gcdSeriesNameQueries("Batman/Spawn")).toEqual(["Spawn", "Batman Spawn"]);
    for (const name of gcdSeriesNameQueries("Batman / Spawn")) {
      expect(name.includes("/")).toBe(false);
      const segment = gcdSeriesNameSegment(name);
      expect(segment).toBeTruthy();
      expect(segment ?? "").not.toMatch(/%2f/i);
      expect(segment ?? "").not.toContain("/");
    }
    expect(gcdSeriesNameSegment("Batman / Spawn")).toBe("Batman%20Spawn");
    expect(gcdSeriesNameKey("Batman / Spawn")).toBe("batman spawn");
    expect(gcdSeriesNameKey("Batman/Spawn")).toBe(gcdSeriesNameKey("Batman / Spawn"));
    expect(gcdSeriesNameKey("Batman - Spawn")).toBe(gcdSeriesNameKey("Batman / Spawn"));
    expect(gcdSeriesNameKey("Batman & Spawn")).toBe(gcdSeriesNameKey("Batman / Spawn"));
  });

  it("ranks the 2022 DC US edition above foreign and older Batman/Spawn series", () => {
    const rows = named([...rowsFrom(fixture.page1), ...rowsFrom(fixture.page2), ...rowsFrom(fixture.page3)]);
    expect(rows.find((row) => row.id === "203583")?.publisherId).toBe("54");
    expect(rows.find((row) => row.id === "203583")?.country).toBe("us");
    const ranked = rankGcdSeries(rows, {
      name: "Batman / Spawn",
      publisher: "DC",
      year: 2022,
      usBook: shelfIsUsBook({ country: "United States", language: "English", barcode }),
    });
    expect(ranked.map((row) => row.id)).toEqual(["203583", "188001", "193753", "211707"]);
    expect(shelfIsUsBook({ country: "Italy", language: "Italian", barcode })).toBe(false);
  });

  it("follows next for Spawn and matches the Todd McFarlane variant from the recorded pages", async () => {
    const asked: string[] = [];
    const issue = parseGcdIssue(fixture.issue);
    expect(issue?.barcode).toBe(barcode);
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        asked.push(name);
        if (name === "Spawn") return named([...rowsFrom(fixture.page1), ...rowsFrom(fixture.page2), ...rowsFrom(fixture.page3)]);
        return [];
      },
      async publisher(id) {
        return publishers[id] ?? null;
      },
      async issue(id) {
        if (id === "2430001") return issue;
        return {
          ...(issue as GcdIssueRow),
          id,
          barcode: "00000000000000000",
          variant: null,
          seriesId: id,
        };
      },
      async issuesByBarcode() {
        return [];
      },
    };
    const hits = await searchGcdMatches(query, barcode, "query", null, {
      catalog,
      publisher: "DC",
      country: "United States",
      language: "English",
    });
    expect(asked).toEqual(["Spawn"]);
    expect(asked.some((name) => name.includes("/"))).toBe(false);
    expect(hits[0]?.id).toBe("2430001");
    expect(hits[0]?.seriesId).toBe("203583");
    expect(hits[0]?.barcode).toBe(barcode);
    expect(hits[0]?.variant).toMatch(/McFarlane/i);
    expect(hits.map((hit) => hit.id)).not.toContain("2430003");
  });

  it("matches the full Batman / Spawn barcode after a slash-safe series search", async () => {
    const asked: string[] = [];
    const fetched: string[] = [];
    let barcodeCalls = 0;
    const variant = parseGcdIssue(fixture.issue);
    const pages = named([...rowsFrom(fixture.page1), ...rowsFrom(fixture.page2), ...rowsFrom(fixture.page3)]);
    const rankedLast = pages.map((row) => {
      if (row.id !== "203583") return row;
      return {
        ...row,
        issues: [
          { id: "2430010", descriptor: "1" },
          { id: "2430001", descriptor: "1 [Todd McFarlane Variant Cover]" },
          { id: "2430088", descriptor: "2" },
        ],
      };
    });
    const fillers: GcdSeriesRow[] = ["901", "902", "903"].map((id) => ({
      id,
      name: "Batman / Spawn",
      yearBegan: 1990,
      yearEnded: 1990,
      format: "one-shot",
      issues: [{ id: `8${id}`, descriptor: "1" }],
      publisher: "Image",
      country: "it",
      language: "it",
    }));
    const spawn = rankedLast.filter((row) => row.id === "4871");
    const crossovers = rankedLast.filter((row) => row.id !== "4871");
    const dc = crossovers.find((row) => row.id === "203583");
    const rest = crossovers.filter((row) => row.id !== "203583");
    const catalog: GcdCatalog = {
      async seriesByName(name) {
        asked.push(name);
        if (name.includes("/") || /%2f/i.test(name)) throw new Error(`slash in name: ${name}`);
        if (name === "Spawn") return [...spawn, ...fillers, ...rest, ...(dc ? [dc] : [])];
        return [];
      },
      async issue(id) {
        fetched.push(id);
        if (id === "2430001") return variant;
        return {
          ...(variant as GcdIssueRow),
          id,
          seriesId: id === "2430010" || id === "2430088" ? "203583" : id,
          barcode: id === "2430010" ? "76194137888600111" : "00000000000000000",
          variant: null,
        };
      },
      async issuesByBarcode() {
        barcodeCalls += 1;
        return [];
      },
    };
    const hits = await searchGcdMatches("Batman / Spawn #1", barcode, "barcode", null, {
      catalog,
      shelfSeries: "Batman / Spawn",
      publisher: "DC",
      country: "United States",
      language: "English",
      year: 2022,
    });
    expect(barcodeCalls).toBe(0);
    expect(asked).toEqual(["Spawn"]);
    expect(asked.some((name) => name.includes("/"))).toBe(false);
    expect(hits[0]?.id).toBe("2430001");
    expect(hits[0]?.seriesId).toBe("203583");
    expect(hits[0]?.barcode).toBe(barcode);
    expect(hits[0]?.variant).toMatch(/McFarlane/i);
    expect(hits.map((hit) => hit.id)).toEqual(["2430001", "2430010", "2430088"]);
    expect(hits[2]?.barcode ?? null).toBeNull();
    expect(fetched).toContain("2430001");
    expect(fetched).toContain("2430010");
    expect(fetched).not.toContain("2430088");
    expect(fetched).not.toContain("2430003");
    expect(fetched.some((id) => id.startsWith("890"))).toBe(false);

    asked.length = 0;
    fetched.length = 0;
    const fromShelf = await searchGcdMatches("", barcode, "barcode", null, {
      catalog,
      shelfSeries: "Batman / Spawn",
      publisher: "DC",
      country: "United States",
      language: "English",
      year: 2022,
    });
    expect(barcodeCalls).toBe(0);
    expect(asked).toEqual(["Spawn"]);
    expect(fromShelf[0]?.id).toBe("2430001");
    expect(fromShelf[0]?.barcode).toBe(barcode);
    expect(fromShelf[0]?.variant).toMatch(/McFarlane/i);
  });

  it("lists every variant of the top series from the cached issue list", async () => {
    const barcode = "76194137888600134";
    const exactId = "3004";
    const issues = Array.from({ length: 19 }, (_, index) => ({
      id: String(3000 + index),
      descriptor: index === 0 ? "1" : `1 [Cover ${index}]`,
    }));
    const fetched: string[] = [];
    const full: GcdSeriesRow = {
      id: "203583",
      name: "Batman / Spawn",
      yearBegan: 2022,
      yearEnded: 2022,
      format: "one-shot",
      issueCount: 19,
      issues,
      publisher: "DC",
      country: "us",
      language: "en",
    };
    const catalog: GcdCatalog = {
      async seriesByName() {
        return [full];
      },
      async issue(id) {
        fetched.push(id);
        return {
          id,
          seriesId: full.id,
          seriesName: full.name,
          number: "1",
          variant: id === exactId ? "Todd McFarlane Variant Cover" : null,
          variantOf: id === "3000" ? null : "3000",
          title: null,
          coverDate: null,
          coverYear: 2022,
          onSaleYear: 2022,
          onSaleDate: null,
          price: null,
          pageCount: null,
          barcode: id === exactId ? barcode : "00000000000000000",
          publisher: "DC",
          writer: null,
          artist: null,
          coverArtist: null,
          characters: null,
          seriesYear: 2022,
          comicvineIssueId: null,
          metronIssueId: null,
        };
      },
      async issuesByBarcode() {
        return [];
      },
    };
    const hits = await searchGcdMatches("Batman / Spawn #1", barcode, "barcode", null, {
      catalog,
      publisher: "DC",
      country: "United States",
      language: "English",
      year: 2022,
    });
    expect(hits).toHaveLength(19);
    expect(hits[0]?.id).toBe(exactId);
    expect(hits[0]?.barcode).toBe(barcode);
    expect(new Set(hits.map((hit) => hit.id)).size).toBe(19);
    expect(fetched.at(-1)).toBe(exactId);
    expect(fetched.length).toBeLessThan(19);
    expect(fetched).not.toContain("3018");
  });

  it("pages the slash-safe Spawn search when the barcode is the only query", async () => {
    resetGcdBudget();
    const urls: string[] = [];
    const catalog = createGcdCatalog(async (url) => {
      urls.push(String(url));
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      if (path === "/api/series/name/Spawn/") return json(fixture.page1);
      if (path === "/api/series/name/Spawn/?page=2") return json(fixture.page2);
      if (path === "/api/series/name/Spawn/?page=3") return json(fixture.page3);
      if (path === "/api/series/name/Batman%20Spawn/") return json(fixture.empty);
      if (path === "/api/publisher/54/") return json({ name: "DC" });
      if (path === "/api/publisher/200/") return json({ name: "Panini Comics" });
      if (path === "/api/publisher/480/") return json({ name: "Image" });
      if (path === "/api/issue/2430001/") return json(fixture.issue);
      return new Response("missing", { status: 500 });
    });
    const hits = await searchGcdMatches("", barcode, "barcode", null, {
      catalog,
      shelfSeries: "Batman / Spawn",
      publisher: "DC",
      country: "United States",
      language: "English",
      year: 2022,
    });
    expect(urls).toEqual([
      "https://www.comics.org/api/series/name/Spawn/",
      "https://www.comics.org/api/series/name/Spawn/?page=2",
      "https://www.comics.org/api/publisher/54/",
      "https://www.comics.org/api/issue/2430001/",
    ]);
    expect(urls.length).toBeLessThanOrEqual(5);
    for (const url of urls) {
      expect(url).not.toMatch(/%2f/i);
      expect(url.toLowerCase()).not.toContain("barcode");
    }
    expect(hits[0]?.id).toBe("2430001");
    expect(hits[0]?.seriesId).toBe("203583");
    expect(hits[0]?.barcode).toBe(barcode);
    expect(hits[0]?.variant).toMatch(/McFarlane/i);
  }, 30_000);

  it("pages through next and counts every page, with Basic auth when a login is saved", async () => {
    resetGcdBudget();
    process.env.GCD_USERNAME = "cody";
    process.env.GCD_PASSWORD = "secret";
    const urls: string[] = [];
    const catalog = createGcdCatalog(async (url, init) => {
      urls.push(String(url));
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("cody:secret").toString("base64")}`);
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      if (path === "/api/series/name/Spawn/") return json(fixture.page1);
      if (path === "/api/series/name/Spawn/?page=2") return json(fixture.page2);
      if (path === "/api/series/name/Spawn/?page=3") return json(fixture.page3);
      if (path === "/api/series/name/Batman%20Spawn/") return json(fixture.empty);
      return new Response("missing", { status: 500 });
    });
    const rows = await catalog.seriesByName("Batman / Spawn");
    expect(urls).toEqual([
      "https://www.comics.org/api/series/name/Spawn/",
      "https://www.comics.org/api/series/name/Spawn/?page=2",
    ]);
    for (const url of urls) {
      const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
      expect(segment).not.toMatch(/%2f/i);
      expect(segment.includes("/")).toBe(false);
    }
    expect(rows.map((row) => row.id)).toContain("203583");
    expect(rows.map((row) => row.id)).toContain("193753");
    expect(rows.map((row) => row.id)).toContain("211707");
  }, 20_000);

  it("stops a typical search at the confident series and reuses series and issue payloads for a week", async () => {
    resetGcdBudget();
    const urls: string[] = [];
    const cache = memoryGcdCache();
    setGcdResponseCacheForTests(cache);
    const catalog = createGcdCatalog(async (url) => {
      urls.push(String(url));
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      if (path === "/api/series/name/Saga/") {
        return json({
          count: 2,
          next: "https://www.comics.org/api/series/name/Saga/?page=2",
          results: [
            {
              api_url: "https://www.comics.org/api/series/9/?format=json",
              name: "Saga",
              country: "us",
              language: "en",
              publisher: "Image",
              year_began: 2012,
              publishing_format: "ongoing series",
              issue_count: 70,
              active_issues: [
                "https://www.comics.org/api/issue/101/?format=json",
                "https://www.comics.org/api/issue/102/?format=json",
                "https://www.comics.org/api/issue/103/?format=json",
              ],
              issue_descriptors: ["1", "1 [Cover B]", "2"],
            },
          ],
        });
      }
      if (path === "/api/issue/101/" || path === "/api/issue/102/") {
        const id = path.includes("102") ? "102" : "101";
        return json({
          api_url: `https://www.comics.org/api/issue/${id}/?format=json`,
          series_name: "Saga",
          series: "https://www.comics.org/api/series/9/",
          number: "1",
          variant_name: id === "102" ? "Cover B" : null,
          barcode: id === "102" ? "70985300001100121" : "70985300001100111",
        });
      }
      return new Response("missing", { status: 500 });
    });
    const hits = await searchGcdMatches("Saga #1 2012", "70985300001100121", "query", null, {
      catalog,
      publisher: "Image",
      country: "United States",
      language: "English",
    });
    expect(urls).toEqual([
      "https://www.comics.org/api/series/name/Saga/",
      "https://www.comics.org/api/issue/101/",
      "https://www.comics.org/api/issue/102/",
    ]);
    expect(urls.length).toBeLessThanOrEqual(5);
    expect(urls.some((url) => url.includes("page=2"))).toBe(false);
    expect(urls.some((url) => url.includes("/issue/103/"))).toBe(false);
    expect(hits.map((hit) => hit.id)).toEqual(["102", "101"]);
    expect(hits[0]?.variant).toMatch(/Cover B/i);
    expect(GCD_RESPONSE_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);

    urls.length = 0;
    const again = await searchGcdMatches("Saga #1 2012", "70985300001100121", "query", null, {
      catalog,
      publisher: "Image",
      country: "United States",
      language: "English",
    });
    expect(urls).toEqual([]);
    expect(again[0]?.id).toBe("102");
    expect(cache.rows.size).toBeGreaterThan(0);

    for (const row of cache.rows.values()) {
      row.fetchedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    }
    urls.length = 0;
    await searchGcdMatches("Saga #1 2012", "70985300001100121", "query", null, {
      catalog,
      publisher: "Image",
      country: "United States",
      language: "English",
    });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.length).toBeLessThanOrEqual(5);
  }, 30_000);

  it("turns a name-search 404 into No GCD series named, and logs the URL", async () => {
    resetGcdBudget();
    const logs: Array<{ message: string; details?: unknown }> = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      logs.push({ message: input.message, details: input.details });
    });
    const catalog = createGcdCatalog(async () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }));
    await expect(searchGcdMatches(query, barcode, "query", null, { catalog })).rejects.toThrow("No GCD series named Batman / Spawn");
    expect(logs.some((line) => /GCD returned 404/.test(line.message))).toBe(false);
    expect(logs.some((line) => line.message === "No GCD series named Spawn" && JSON.stringify(line.details).includes("/api/series/name/Spawn/"))).toBe(true);
    expect(logs.some((line) => JSON.stringify(line.details).includes("/api/series/name/Batman%20Spawn/"))).toBe(true);
  });

  it("shows a saved GCD login as signed in on the 2,000 per day window", () => {
    const anon = gcdUsage(emptyGcdRate(), 1_700_000_000_000, false);
    expect(anon.signedIn).toBe(false);
    expect(anon.limit).toBe(30);
    expect(anon.label).toBe("Hour");
    const signed = gcdUsage(emptyGcdRate(), 1_700_000_000_000, true);
    expect(signed.signedIn).toBe(true);
    expect(signed.limit).toBe(2000);
    expect(signed.label).toBe("Day");
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function memoryGcdCache(): GcdResponseCache & { rows: Map<string, GcdCachedResponse> } {
  const rows = new Map<string, GcdCachedResponse>();
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
