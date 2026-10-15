import { describe, expect, it } from "vitest";
import { gcdCoverScan, parseGcdIssue } from "@/lib/catalog/gcd";
import { linkUpdate } from "@/lib/catalog/link-plan";
import { readManualLink, shouldSaveCatalogCover, withUserCover } from "@/lib/catalog/manual-link";
import { imagePaceName } from "@/lib/catalog/rate-limit";
import { gcdDetails, gcdHit } from "@/lib/covers/gcd-match";
import { coverContentType, coverFilename } from "@/lib/covers/files";

const PARENT = "https://files1.comics.org/img/gcd/covers_by_id/10/w400/10.jpg";
const VARIANT = "https://files1.comics.org/img/gcd/covers_by_id/11/w400/11.jpg";

function issue(id: string, cover: string, variantOf: string | null = null) {
  return parseGcdIssue({
    api_url: `https://www.comics.org/api/issue/${id}/`,
    series: "https://www.comics.org/api/series/9/",
    series_name: "Saga (2012 series)",
    number: "1",
    variant_name: variantOf ? "Virgin Cover" : null,
    variant_of: variantOf ? `https://www.comics.org/api/issue/${variantOf}/` : null,
    cover,
  });
}

describe("GCD cover scans", () => {
  it("puts the issue cover on the match row and leaves automatic backfill without an image", () => {
    expect(gcdCoverScan("")).toBeNull();
    expect(gcdCoverScan("http://files1.comics.org/img/a.jpg")).toBe("https://files1.comics.org/img/a.jpg");
    const parent = issue("10", PARENT);
    const variant = issue("11", VARIANT, "10");
    expect(parent?.coverUrl).toBe(PARENT);
    expect(variant?.coverUrl).toBe(VARIANT);
    expect(variant?.coverUrl).not.toBe(parent?.coverUrl);
    expect(gcdDetails(parent!).imageUrl).toBeNull();
    expect(gcdHit(variant!).coverUrl).toBe(VARIANT);
    expect(gcdHit(variant!).covers).toEqual([{ label: "Cover", imageUrl: VARIANT }]);
    expect(gcdHit(issue("12", "")!).coverUrl).toBeNull();
    expect(gcdHit(issue("12", "")!).covers).toEqual([]);
  });

  it("saves a variant scan and refuses to replace a photo unless replace existing is set", () => {
    expect(shouldSaveCatalogCover({ useCover: true, userCover: false, replaceExisting: false })).toBe(true);
    expect(shouldSaveCatalogCover({ useCover: false, userCover: false, replaceExisting: false })).toBe(false);
    expect(shouldSaveCatalogCover({ useCover: true, userCover: true, replaceExisting: false })).toBe(false);
    expect(shouldSaveCatalogCover({ useCover: true, userCover: true, replaceExisting: true })).toBe(true);

    const variant = gcdHit(issue("11", VARIANT, "10")!);
    const saved = linkUpdate({
      source: "gcd",
      hit: variant,
      current: {},
      fieldSources: {},
      manualLink: null,
      detail: null,
      fillMissing: false,
      cover: { file: "gcd-11.jpg", url: "/covers/files/gcd-11.jpg", imageUrl: VARIANT },
    });
    expect(saved.data.coverFile).toBe("gcd-11.jpg");
    expect(saved.data.coverUrl).toBe("/covers/files/gcd-11.jpg");
    expect(saved.data.coverStatus).toBe("matched");
    expect(saved.data.coverNote).toBeNull();
    expect(readManualLink(saved.data.manualLink)).toMatchObject({
      gcdIssueId: "11",
      coverSource: "gcd",
      coverImageUrl: VARIANT,
      userCover: false,
    });

    const photo = linkUpdate({
      source: "gcd",
      hit: variant,
      current: {},
      fieldSources: {},
      manualLink: withUserCover(null, "user-cmv777zqb000sqxabc70ckhaw-original.jpg"),
      detail: null,
      fillMissing: false,
      cover: null,
    });
    expect(photo.data.coverFile).toBeUndefined();
    expect(photo.data.coverUrl).toBeUndefined();
    expect(photo.data.coverStatus).toBeUndefined();
    expect(readManualLink(photo.data.manualLink).userCover).toBe(true);
    expect(readManualLink(photo.data.manualLink).coverSource).toBeNull();
  });

  it("serves a gcd cover file and paces image hosts apart from the API windows", () => {
    expect(coverFilename("11", "jpeg", "gcd")).toBe("gcd-11.jpg");
    expect(coverContentType("gcd-11.jpg")).toBe("image/jpeg");
    expect(coverContentType("gcd-11-ab12cd34.png")).toBe("image/png");
    expect(imagePaceName("files1.comics.org")).toBe("gcd-images");
    expect(imagePaceName("comicvine.gamespot.com")).toBe("comicvine-images");
    expect(imagePaceName("static.metron.cloud")).toBe("covers");
    expect(imagePaceName("www.comics.org")).toBe("covers");
  });
});
