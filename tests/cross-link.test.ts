import { describe, expect, it } from "vitest";
import { parseGcdIssue } from "@/lib/catalog/gcd";
import { linkUpdate } from "@/lib/catalog/link-plan";
import { backfillCovers } from "@/lib/covers/backfill";
import { blankCrossIds, crossLinkDownloadsCover, lookupCrossIssue, pickExactCrossHit } from "@/lib/covers/cross-link";
import { mapMetronDetails, type MetronDetails } from "@/lib/covers/enrich";
import { emptyBudget, MetronLimiter, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";
import { mapIssue, metronIssuesByCrossId, type MetronTransport } from "@/lib/covers/metron-client";
import type { CoverLookup, CoverRecord, MetronIssueHit } from "@/lib/covers/types";

const image = "https://static.metron.cloud/media/issue/saga-1.jpg";

function hit(overrides: Partial<MetronIssueHit> = {}): MetronIssueHit {
  return {
    id: "50",
    seriesId: "15",
    seriesName: "Saga",
    number: "1",
    coverYear: 2012,
    imageUrl: image,
    label: "Saga (2012) #1",
    cvId: "400",
    ...overrides,
  };
}

function copy(overrides: Partial<CoverRecord> = {}): CoverRecord {
  return {
    id: "comic-1",
    series: "Saga",
    issueNo: "1",
    issue: "1",
    coverYear: 2012,
    barcode: null,
    variant: null,
    publisher: "Image",
    coverFile: null,
    coverStatus: null,
    metronIssueId: null,
    ...overrides,
  };
}

function detail(overrides: Partial<MetronDetails> = {}): MetronDetails {
  return {
    id: "50",
    seriesId: "15",
    seriesName: "Saga",
    number: "1",
    imageUrl: image,
    coverDate: null,
    coverYear: 2012,
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
    seriesYear: 2012,
    seriesVolume: null,
    metronIssueUrl: null,
    metronSeriesUrl: null,
    comicvineIssueId: "400",
    comicvineSeriesId: "77",
    gcdIssueId: "256114",
    gcdSeriesId: "99",
    ...overrides,
  };
}

describe("exact cross-id hits", () => {
  it("keeps one issue and refuses a shared or disagreeing id", () => {
    const one = pickExactCrossHit([hit()], "cvId", "400");
    const filtered = pickExactCrossHit([hit({ cvId: null })], "cvId", "400");
    expect("hit" in one && one.hit.id).toBe("50");
    expect("hit" in filtered && filtered.hit.id).toBe("50");
    const many = pickExactCrossHit([hit(), hit({ id: "51" })], "cvId", "400");
    expect("ids" in many && many.ids).toEqual(["50", "51"]);
    const wrong = pickExactCrossHit([hit({ cvId: "999" })], "cvId", "400");
    expect("reason" in wrong && wrong.reason).toMatch(/no issue/);
  });

  it("does not look up Metron when a hand-picked Metron id is already stored", async () => {
    const decision = await lookupCrossIssue(
      { id: "1", series: "Saga", issueNo: "1", issue: "1", metronIssueId: null, manualMetronIssueId: "88", comicvineIssueId: "400" },
      { byComicVine: async () => { throw new Error("should not search"); }, byGcd: async () => [] },
    );
    expect(decision.status).toBe("skip");
  });

  it("uses a Metron id named on the GCD record, then the gcd_id filter", async () => {
    const embedded = await lookupCrossIssue(
      { id: "1", series: "Saga", issueNo: "1", issue: "1", metronIssueId: null, gcdIssueId: "256114", embeddedMetronIssueId: "50" },
      { byComicVine: async () => [], byGcd: async () => { throw new Error("filter should wait"); } },
    );
    expect(embedded).toMatchObject({ status: "linked", via: "gcd_id", hit: { id: "50" } });
    const filtered = await lookupCrossIssue(
      { id: "1", series: "Saga", issueNo: "1", issue: "1", metronIssueId: null, gcdIssueId: "256114" },
      { byComicVine: async () => [], byGcd: async (id) => { expect(id).toBe("256114"); return [hit({ id: "50", gcdId: "256114", cvId: null })]; } },
    );
    expect(filtered).toMatchObject({ status: "linked", hit: { id: "50" } });
  });

  it("leaves an uploaded cover in place", () => {
    expect(crossLinkDownloadsCover({ userCover: true, coverFile: null, coverStatus: "manual" })).toBe(false);
    expect(crossLinkDownloadsCover({ userCover: false, coverFile: "metron-50.jpg", coverStatus: "matched" })).toBe(false);
    expect(crossLinkDownloadsCover({ userCover: false, coverFile: null, coverStatus: null })).toBe(true);
  });
});

describe("ids stored from a Metron issue", () => {
  it("fills a blank Comic Vine id and GCD id and leaves a hand-picked id alone", () => {
    expect(blankCrossIds({}, {}, null, detail())).toEqual({
      comicvineIssueId: "400",
      comicvineSeriesId: "77",
      gcdIssueId: "256114",
      gcdSeriesId: "99",
    });
    expect(blankCrossIds({ comicvineIssueId: "9" }, { comicvineIssueId: "user" }, { comicvineIssueId: "9" }, detail()).comicvineIssueId).toBeUndefined();
    expect(blankCrossIds({ gcdIssueId: "1" }, {}, { gcdIssueId: "1" }, detail()).gcdIssueId).toBeUndefined();
    const update = linkUpdate({
      source: "metron",
      hit: { source: "metron", id: "50", seriesId: "15", series: "Saga", issueNo: "1", variant: null, coverDate: null, publisher: "Image", coverUrl: image, covers: [] },
      current: {},
      fieldSources: {},
      manualLink: null,
      detail: detail(),
      fillMissing: false,
      cover: null,
    });
    expect(update.data.metronIssueId).toBe("50");
    expect(update.data.comicvineIssueId).toBe("400");
    expect(update.data.gcdIssueId).toBe("256114");
    expect(update.data.plot).toBeUndefined();
  });

  it("reads cv_id and gcd_id off a Metron payload", () => {
    expect(mapIssue({ id: 50, number: "1", series: { id: 15, name: "Saga" }, cv_id: 400, gcd_id: 256114 })?.cvId).toBe("400");
    expect(mapIssue({ id: 50, number: "1", series: { id: 15, name: "Saga" }, cv_id: 400, gcd_id: 256114 })?.gcdId).toBe("256114");
    const mapped = mapMetronDetails({ id: 50, number: "1", series: { id: 15, name: "Saga", cv_id: 77, gcd_id: 99 }, cv_id: 400, gcd_id: 256114 });
    expect(mapped?.comicvineIssueId).toBe("400");
    expect(mapped?.gcdIssueId).toBe("256114");
    expect(mapped?.gcdSeriesId).toBe("99");
  });
});

describe("GCD cross-ids", () => {
  it("reads a Comic Vine or Metron id when the payload has one", () => {
    const bare = parseGcdIssue({ api_url: "https://www.comics.org/api/issue/256114/", series_name: "Saga (2012 series)", number: "1" });
    expect(bare?.comicvineIssueId).toBeNull();
    expect(bare?.metronIssueId).toBeNull();
    const named = parseGcdIssue({
      api_url: "https://www.comics.org/api/issue/256114/",
      series_name: "Saga (2012 series)",
      number: "1",
      cv_id: "400",
      metron_id: "50",
    });
    expect(named?.comicvineIssueId).toBe("400");
    expect(named?.metronIssueId).toBe("50");
  });
});

describe("backfill cross-link", () => {
  it("links the Metron issue for a Comic Vine id and does not search by name", async () => {
    const marked: string[] = [];
    const saved: string[] = [];
    const lookup: CoverLookup = {
      async issuesByUpc() { throw new Error("barcode should wait"); },
      async issuesByUpcPrefix() { return []; },
      async searchSeries() { throw new Error("name search should wait"); },
      async issuesForSeries() { return []; },
    };
    const summary = await backfillCovers({
      comics: [copy({ comicvineIssueId: "400" })],
      lookup,
      fileExists: () => false,
      saveImage: async (issue) => {
        saved.push(issue.id);
        return `metron-${issue.id}.jpg`;
      },
      markMatched: async (_id, update) => { marked.push(update.metronIssueId); },
      markUnmatched: async () => { throw new Error("should link"); },
      crossLookup: {
        byComicVine: async (id) => {
          expect(id).toBe("400");
          return [hit()];
        },
        byGcd: async () => [],
      },
      log: () => undefined,
    });
    expect(summary.matched).toBe(1);
    expect(marked).toEqual(["50"]);
    expect(saved).toEqual(["50"]);
  });

  it("leaves several Metron issues unmatched", async () => {
    const reasons: string[] = [];
    const summary = await backfillCovers({
      comics: [copy({ comicvineIssueId: "400" })],
      lookup: {
        async issuesByUpc() { return []; },
        async issuesByUpcPrefix() { return []; },
        async searchSeries() { throw new Error("name search should wait"); },
        async issuesForSeries() { return []; },
      },
      fileExists: () => false,
      saveImage: async () => { throw new Error("should not download"); },
      markMatched: async () => { throw new Error("should not link"); },
      markUnmatched: async (_id, reason) => { reasons.push(reason); },
      crossLookup: {
        byComicVine: async () => [hit(), hit({ id: "51" })],
        byGcd: async () => [],
      },
    });
    expect(summary.unmatched).toBe(1);
    expect(reasons[0]).toMatch(/Several Metron issues share Comic Vine 400/);
  });
});

describe("Metron cv_id request", () => {
  it("asks Metron for the issue with that Comic Vine id", async () => {
    const urls: string[] = [];
    const budget: MetronBudget = emptyBudget();
    const store: BudgetStore = { read: () => budget, write: (next) => Object.assign(budget, next) };
    const transport: MetronTransport = {
      limiter: new MetronLimiter(store, () => 0, async () => undefined, () => "2026-10-14"),
      username: "cody",
      password: "secret",
      baseUrl: "https://metron.cloud/api",
      now: () => 0,
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json({ results: [{ id: 50, number: "1", series: { id: 15, name: "Saga" }, cv_id: 400 }] });
      },
    };
    const hits = await metronIssuesByCrossId(transport, "cv_id", "400");
    expect(urls).toEqual(["https://metron.cloud/api/issue/?cv_id=400"]);
    expect(hits.map((issue) => issue.id)).toEqual(["50"]);
  });
});
