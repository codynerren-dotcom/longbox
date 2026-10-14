import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { manualLinkJson, readManualLink, stripLockedCover, withLinkedId, withoutLinkedId, withUserCover, withoutUserCover } from "@/lib/catalog/manual-link";
import { backfillCovers, needsCover } from "@/lib/covers/backfill";
import { coverContentType, writeUserCoverFiles } from "@/lib/covers/files";
import { decodeHeic, readCrop, renderCover, sniffImage } from "@/lib/covers/photo";
import { portraitFrame } from "@/lib/covers/portrait";
import type { CoverLookup, CoverRecord } from "@/lib/covers/types";
import { safeImageUrl } from "@/lib/url";

const COMIC_ID = "cmv777zpl0000qxab8sd3hpyd";
const ORIGINAL = `user-${COMIC_ID}-original.jpg`;

function record(overrides: Partial<CoverRecord> = {}): CoverRecord {
  return {
    id: "comic-1",
    series: "Saga",
    issueNo: "1",
    issue: "1",
    coverYear: 2012,
    barcode: null,
    variant: null,
    publisher: null,
    coverFile: null,
    coverStatus: null,
    metronIssueId: null,
    ...overrides,
  };
}

function lookup(): CoverLookup {
  return {
    issuesByUpc: async () => {
      throw new Error("searched");
    },
    issuesByUpcPrefix: async () => {
      throw new Error("searched");
    },
    searchSeries: async () => {
      throw new Error("searched");
    },
    issuesForSeries: async () => {
      throw new Error("searched");
    },
  };
}

describe("portrait crop", () => {
  it("fits a 2:3 window, zooms in, and pans to the edge", () => {
    const wide = portraitFrame(3000, 1000, 0, 0, 0, 1);
    expect((wide.width * 3000) / (wide.height * 1000)).toBeCloseTo(2 / 3, 5);
    expect(wide.y).toBeCloseTo(0, 5);
    expect(wide.x).toBeGreaterThan(0);
    const zoomed = portraitFrame(3000, 1000, 0, 0, 0, 2);
    expect(zoomed.width).toBeCloseTo(wide.width / 2, 5);
    const right = portraitFrame(3000, 1000, 0, 1, 0, 1);
    expect(right.x + right.width).toBeCloseTo(1, 5);
    const turned = portraitFrame(1000, 3000, 90, 0, 0, 1);
    expect(turned.width).toBeCloseTo(wide.width, 5);
    expect(turned.height).toBeCloseTo(wide.height, 5);
  });

  it("rejects a crop that leaves the photo", () => {
    expect(readCrop({ x: "0.1", y: "0.1", width: "0.5", height: "0.8" })).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.8 });
    expect(readCrop({ x: 0.5, y: 0, width: 0.6, height: 0.5 })).toBeNull();
    expect(readCrop({ x: "nope", y: 0, width: 1, height: 1 })).toBeNull();
  });
});

describe("cover photos", () => {
  it("sniffs jpeg, png, webp, and heic, and ignores other bytes", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
    const heic = readFileSync(path.join(process.cwd(), "tests/fixtures/sample.heic"));
    expect(sniffImage(jpeg)).toBe("jpg");
    expect(sniffImage(png)).toBe("png");
    expect(sniffImage(webp)).toBe("webp");
    expect(sniffImage(heic)).toBe("heic");
    expect(sniffImage(Buffer.from("not a photo"))).toBeNull();
  });

  it("resizes a large jpeg and a png to a webp no wider than 1200px", async () => {
    const jpeg = await sharp({ create: { width: 2400, height: 3600, channels: 3, background: { r: 180, g: 20, b: 40 } } })
      .jpeg()
      .toBuffer();
    const webp = await renderCover(jpeg, 0, portraitFrame(2400, 3600, 0, 0, 0, 1));
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(1200);
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1200);

    const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 80, b: 160 } } })
      .png()
      .toBuffer();
    const turned = await renderCover(png, 90, null);
    const turnedMeta = await sharp(turned).metadata();
    expect(turnedMeta.format).toBe("webp");
    expect((turnedMeta.width ?? 0) / (turnedMeta.height ?? 1)).toBeCloseTo(2 / 3, 1);
    expect(Math.max(turnedMeta.width ?? 0, turnedMeta.height ?? 0)).toBeLessThanOrEqual(1200);
  });

  it("converts a heic photo to webp and keeps the original bytes beside it", async () => {
    const heic = readFileSync(path.join(process.cwd(), "tests/fixtures/sample.heic"));
    const jpeg = await decodeHeic(heic);
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const webp = await renderCover(heic, 0, null);
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
    const fake = Buffer.alloc(32);
    fake.write("ftypheic", 4);
    await expect(renderCover(fake, 0, null)).rejects.toThrow(/HEIC/);

    const dir = await mkdtemp(path.join(tmpdir(), "longbox-covers-"));
    const stored = await writeUserCoverFiles({ comicId: COMIC_ID, original: heic, webp, ext: "heic", dir });
    expect(stored.coverFile).toBe(`user-${COMIC_ID}.webp`);
    expect(stored.originalFile).toBe(`user-${COMIC_ID}-original.heic`);
    expect(await readFile(path.join(dir, stored.originalFile))).toEqual(heic);
    expect(coverContentType(stored.coverFile)).toBe("image/webp");
    expect(coverContentType(stored.originalFile)).toBeNull();
    expect(safeImageUrl(`/covers/files/${stored.coverFile}`)).toBe(`/covers/files/${stored.coverFile}`);
    expect(safeImageUrl(`/covers/files/${stored.originalFile}`)).toBeNull();
    expect(safeImageUrl("/covers/files/../user-cmv777zpl0000qxab8sd3hpyd.webp")).toBeNull();
  });
});

describe("manual covers stay put", () => {
  it("marks an upload so backfill and a later Metron write cannot replace it", async () => {
    const uploaded = withUserCover({ metronIssueId: "88" }, ORIGINAL);
    expect(uploaded.userCover).toBe(true);
    expect(uploaded.originalFile).toBe(ORIGINAL);
    expect(uploaded.metronIssueId).toBe("88");
    expect(withUserCover(null, "../secret.jpg").originalFile).toBeNull();
    expect(withLinkedId(uploaded, "comicvine", "400", null).userCover).toBe(true);
    const replaced = withLinkedId(uploaded, "metron", "88", "https://cdn.example/cover.jpg");
    expect(replaced.userCover).toBe(false);
    expect(replaced.originalFile).toBe(ORIGINAL);
    expect(withoutLinkedId(uploaded, "metron").userCover).toBe(true);
    expect(withoutLinkedId(uploaded, "metron").originalFile).toBe(ORIGINAL);
    expect(manualLinkJson(withoutUserCover({ originalFile: ORIGINAL }))?.originalFile).toBe(ORIGINAL);
    expect(manualLinkJson(withoutUserCover({ originalFile: ORIGINAL }))?.userCover).toBe(false);
    expect(manualLinkJson(null)).toBeNull();
    expect(readManualLink({ userCover: "yes", originalFile: "notes.txt" })).toMatchObject({ userCover: false, originalFile: null });

    const kept = { coverFile: "metron-88.jpg", coverUrl: "/covers/files/metron-88.jpg", coverStatus: "matched", title: "Saga" };
    stripLockedCover(kept, uploaded);
    expect(kept.coverFile).toBeUndefined();
    expect(kept.title).toBe("Saga");
    const chosen = { coverFile: "metron-88.jpg", manualLink: replaced };
    stripLockedCover(chosen, uploaded);
    expect(chosen.coverFile).toBe("metron-88.jpg");

    expect(needsCover(record({ userCover: true, coverFile: null }), () => false)).toBe(false);
    expect(needsCover(record({ coverStatus: "manual", coverFile: "user.webp" }), () => false)).toBe(false);
    const summary = await backfillCovers({
      comics: [record({ userCover: true, coverStatus: "manual" })],
      lookup: lookup(),
      fileExists: () => false,
      saveImage: async () => {
        throw new Error("downloaded");
      },
      markMatched: async () => {
        throw new Error("matched");
      },
      markUnmatched: async () => {
        throw new Error("unmatched");
      },
    });
    expect(summary).toMatchObject({ pending: 0, matched: 0, skipped: 1 });
  });

  it("offers upload, a rear camera, and a Metron revert on the issue page", () => {
    const page = readFileSync("src/app/issues/[id]/page.tsx", "utf8");
    const controls = readFileSync("src/app/issues/cover-controls.tsx", "utf8");
    const form = readFileSync("src/app/issues/edit-form.tsx", "utf8");
    const route = readFileSync("src/app/covers/files/[name]/route.ts", "utf8");
    expect(page).toContain("CoverControls");
    expect(page).toContain('placement={hasCover ? "menu" : "overlay"}');
    expect(page).toContain("coverTools");
    expect(page).not.toContain("—");
    expect(form).toContain("coverTools");
    expect(controls).toContain("Upload cover");
    expect(controls).toContain("Take photo");
    expect(controls).toContain('capture="environment"');
    expect(controls).toContain('facingMode: { ideal: "environment" }');
    expect(controls).toContain("Revert to Metron cover");
    expect(controls).toContain("Use this crop");
    expect(readFileSync("src/lib/log/events.ts", "utf8")).toContain("Uploaded a cover for");
    expect(readFileSync("src/lib/covers/run.ts", "utf8")).toContain("was uploaded and was left as it is");
    expect(route).toContain('name.startsWith("user-") ? "no-cache"');
  });
});
