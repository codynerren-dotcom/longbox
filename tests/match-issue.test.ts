import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { linkUpdate, unlinkUpdate } from "@/lib/catalog/link-plan";
import { mapComicVineMatchHit, mapMetronMatchHit, orderMatchHits, variantCoversFrom } from "@/lib/catalog/match-hits";
import { manualLinkJson, matchQuery, parseMatchQuery, readManualLink, withLinkedId, withoutLinkedId } from "@/lib/catalog/manual-link";
import { backfillCovers } from "@/lib/covers/backfill";
import { mapMetronDetails } from "@/lib/covers/enrich";
import { coverFileKey } from "@/lib/covers/files";
import type { CoverLookup, CoverRecord } from "@/lib/covers/types";
import { showSlabSection } from "@/lib/issue-view";
import { safeImageUrl } from "@/lib/url";

const image = "https://static.metron.cloud/media/issue/brzrkr-4.jpg";
const variantImage = "https://static.metron.cloud/media/issue/brzrkr-4b.jpg";

function record(overrides: Partial<CoverRecord> = {}): CoverRecord {
  return {
    id: "comic-1",
    series: "BRZRKR",
    issueNo: "4",
    issue: "4",
    coverYear: 2021,
    barcode: null,
    variant: null,
    publisher: "Boom!",
    coverFile: null,
    coverStatus: null,
    metronIssueId: null,
    ...overrides,
  };
}

function lookup(): CoverLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async issuesByUpc() {
      calls.push("upc");
      return [];
    },
    async issuesByUpcPrefix() {
      calls.push("prefix");
      return [];
    },
    async searchSeries() {
      calls.push("series");
      return [];
    },
    async issuesForSeries() {
      calls.push("issues");
      return [];
    },
  };
}

describe("match query", () => {
  it("prefills series, issue, and year, then parses them back", () => {
    const query = matchQuery({ series: "BRZRKR", issueNo: "4", year: 2021 });
    expect(query).toBe("BRZRKR #4 2021");
    expect(parseMatchQuery(query)).toEqual({ series: "BRZRKR", issueNo: "4", year: 2021 });
    expect(parseMatchQuery("The Walking Dead #1")).toEqual({ series: "The Walking Dead", issueNo: "1", year: null });
  });
});

describe("catalog hits", () => {
  it("keeps variant covers from a Metron issue", () => {
    const hit = mapMetronMatchHit({
      id: 88,
      number: "4",
      cover_date: "April 2021",
      image: image,
      series: { id: 12, name: "BRZRKR", publisher: { name: "Boom! Studios" } },
      variants: [{ name: "Cover B", image: variantImage }],
    });
    expect(hit).toMatchObject({
      source: "metron",
      id: "88",
      series: "BRZRKR",
      issueNo: "4",
      publisher: "Boom! Studios",
      coverDate: "April 2021",
      coverUrl: image,
    });
    expect(hit?.covers).toEqual([
      { label: "Cover", imageUrl: image },
      { label: "Cover B", imageUrl: variantImage },
    ]);
    expect(variantCoversFrom({ image, variants: [{ name: "Cover B", image: variantImage }] })).toHaveLength(2);
  });

  it("maps a Comic Vine issue and sorts the requested year first", () => {
    const hit = mapComicVineMatchHit(
      {
        id: 400,
        issue_number: "4",
        name: "The Book of Nowhere",
        cover_date: "2021-04-01",
        image: { medium_url: "https://comicvine.gamespot.com/a/uploads/scale_medium/brzrkr.jpg" },
        volume: { id: 40, name: "BRZRKR" },
      },
      "Boom! Studios",
    );
    expect(hit).toMatchObject({
      source: "comicvine",
      id: "400",
      seriesId: "40",
      series: "BRZRKR",
      issueNo: "4",
      variant: "The Book of Nowhere",
      publisher: "Boom! Studios",
    });
    const ordered = orderMatchHits(
      [
        { ...hit!, coverDate: "2020-01-01", id: "1" },
        { ...hit!, coverDate: "2021-04-01", id: "2" },
      ],
      2021,
    );
    expect(ordered.map((item) => item.id)).toEqual(["2", "1"]);
  });
});

describe("manual links", () => {
  const hit = mapMetronMatchHit({
    id: 88,
    number: "4",
    image,
    series: { id: 12, name: "BRZRKR", publisher: { name: "Boom!" } },
  })!;
  const detail = mapMetronDetails({
    id: 88,
    number: "4",
    title: "The Book of Nowhere",
    name: ["The Book of Nowhere"],
    cover_date: "2021-04-01",
    image,
    desc: "Unute keeps moving.",
    series: { id: 12, name: "BRZRKR" },
    cv_id: 400,
  })!;

  it("stores both catalog ids and does not treat the hand-picked id as an automatic fill", () => {
    const linked = withLinkedId(null, "comicvine", "400", null);
    const update = linkUpdate({
      source: "metron",
      hit,
      current: { comicvineIssueId: "400", title: "Already named" },
      fieldSources: {},
      manualLink: linked,
      detail,
      fillMissing: true,
      cover: { file: "metron-88.jpg", url: "/covers/files/metron-88.jpg", imageUrl: image },
      issueUrl: "https://metron.cloud/issue/brzrkr-4/",
    });
    expect(update.data.metronIssueId).toBe("88");
    expect(update.data.comicvineIssueId).toBeUndefined();
    expect(update.data.title).toBeUndefined();
    expect(update.data.plot).toBe("Unute keeps moving.");
    expect(update.filled).not.toContain("metronIssueId");
    expect(update.filled).toContain("plot");
    expect(readManualLink(update.data.manualLink)).toMatchObject({
      metronIssueId: "88",
      comicvineIssueId: "400",
      coverImageUrl: image,
      coverSource: "metron",
    });
  });

  it("unlinks one catalog and keeps the other", () => {
    const both = withLinkedId(withLinkedId(null, "metron", "88", image), "comicvine", "400", null);
    const data = unlinkUpdate({ source: "metron", fieldSources: { metronIssueId: "metron", plot: "metron" }, manualLink: both });
    expect(data.metronIssueId).toBeNull();
    expect(data.comicvineIssueId).toBeUndefined();
    expect(readManualLink(data.manualLink)).toMatchObject({ metronIssueId: null, comicvineIssueId: "400", coverImageUrl: null });
    expect(data.fieldSources).toEqual({ plot: "metron" });
    expect(manualLinkJson(withoutLinkedId(withoutLinkedId(both, "metron"), "comicvine"))).toBeNull();
  });

  it("does not search Metron again when the issue was linked by hand", async () => {
    const catalog = lookup();
    const saved: string[] = [];
    const matched: string[] = [];
    await backfillCovers({
      comics: [record({ manualMetronIssueId: "88", manualCoverImageUrl: image })],
      lookup: catalog,
      fileExists: () => false,
      saveImage: async (issue) => {
        saved.push(`${issue.id}|${issue.imageUrl}`);
        return "metron-88.jpg";
      },
      markMatched: async (_id, update) => {
        matched.push(update.metronIssueId);
      },
      markUnmatched: async () => {
        throw new Error("manual link should not be marked unmatched");
      },
    });
    expect(catalog.calls).toEqual([]);
    expect(saved).toEqual([`88|${image}`]);
    expect(matched).toEqual(["88"]);
    expect(coverFileKey("88", variantImage, image)).toMatch(/^88-[a-f0-9]{8}$/);
    expect(coverFileKey("88", image, image)).toBe("88");
  });
});

describe("issue page", () => {
  it("shows the slab block only for a slabbed copy and offers Match / Link", () => {
    expect(showSlabSection("Slabbed")).toBe(true);
    expect(showSlabSection("Raw")).toBe(false);
    expect(showSlabSection(null)).toBe(false);
    const page = readFileSync("src/app/issues/[id]/page.tsx", "utf8");
    const panel = readFileSync("src/app/issues/match-panel.tsx", "utf8");
    expect(page).toContain("showSlabSection");
    expect(page).not.toContain("Raw copy");
    expect(panel).toContain("Match / Link");
    expect(panel).toContain("Use this cover");
    expect(panel).toContain("Fill missing details");
    expect(panel).toContain("Unlink GCD");
    expect(panel).toContain("GCD data is CC BY-SA");
    expect(panel).toContain("Unlink Metron");
    expect(panel).toContain("Re-pull cover");
    expect(safeImageUrl("/covers/files/cv-400.jpg")).toBe("/covers/files/cv-400.jpg");
    expect(safeImageUrl("/covers/files/metron-88-ab12cd34.jpg")).toBe("/covers/files/metron-88-ab12cd34.jpg");
  });
});
