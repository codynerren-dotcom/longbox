import { describe, expect, it } from "vitest";
import {
  comicVineIssueHref,
  comicVineVolumeHref,
  issueCatalogLinks,
  metronIssueHref,
  metronSeriesHref,
  metronSiteUrl,
  seriesCatalogLinks,
} from "@/lib/catalog-links";

describe("catalog links", () => {
  it("prefers a Metron site link and otherwise uses the numeric id", () => {
    expect(metronIssueHref("50", "https://metron.cloud/issue/saga-2012-1/")).toBe("https://metron.cloud/issue/saga-2012-1/");
    expect(metronIssueHref("50", "http://www.metron.cloud/issue/saga-2012-1")).toBe("https://metron.cloud/issue/saga-2012-1/");
    expect(metronIssueHref("50", "https://metron.cloud/api/issue/50/")).toBe("https://metron.cloud/issue/50/");
    expect(metronIssueHref("50", null)).toBe("https://metron.cloud/issue/50/");
    expect(metronSeriesHref("15", "https://metron.cloud/series/saga-2012/")).toBe("https://metron.cloud/series/saga-2012/");
    expect(metronSeriesHref("15", null)).toBe("https://metron.cloud/series/15/");
    expect(metronSiteUrl("https://evil.example/issue/50/", "issue")).toBeNull();
    expect(metronIssueHref("0", null)).toBeNull();
    expect(metronIssueHref(null, null)).toBeNull();
  });

  it("builds Comic Vine issue and volume urls and hides a missing id", () => {
    expect(comicVineIssueHref("12345")).toBe("https://comicvine.gamespot.com/issue/4000-12345/");
    expect(comicVineVolumeHref("4001")).toBe("https://comicvine.gamespot.com/volume/4050-4001/");
    expect(comicVineIssueHref("0")).toBeNull();
    expect(comicVineIssueHref("abc")).toBeNull();
    expect(comicVineVolumeHref(null)).toBeNull();
    expect(issueCatalogLinks({})).toEqual({ metron: null, comicVine: null });
    expect(issueCatalogLinks({ metronIssueId: "50", comicvineIssueId: "9" })).toEqual({
      metron: "https://metron.cloud/issue/50/",
      comicVine: "https://comicvine.gamespot.com/issue/4000-9/",
    });
  });

  it("uses the series id that most copies share", () => {
    const links = seriesCatalogLinks([
      { metronSeriesId: "15", comicvineSeriesId: "77" },
      { metronSeriesId: "15", metronSeriesUrl: "https://metron.cloud/series/saga-2012/", comicvineSeriesId: "77" },
      { metronSeriesId: "99", comicvineSeriesId: "8" },
    ]);
    expect(links.metron).toBe("https://metron.cloud/series/saga-2012/");
    expect(links.comicVine).toBe("https://comicvine.gamespot.com/volume/4050-77/");
    expect(seriesCatalogLinks([{}])).toEqual({ metron: null, comicVine: null });
  });
});
