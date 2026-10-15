import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLZ_HEADERS } from "@/lib/clz/headers";
import { isLegacyZeroCoreKey, legacyZeroCoreKeys, planZeroIdCleanup, type LegacyZeroRow } from "@/lib/clz/legacy-zero";
import {
  ClzParseError,
  costBasis,
  mergeByDedupeKey,
  normalizeClzRecord,
  parseClzCsv,
  parseClzDate,
  parseClzPrice,
  planImport,
  usableCoreId,
} from "@/lib/clz/parse";
import { computeStats } from "@/lib/stats";

const fixturePath = path.join(process.cwd(), "fixtures/clz-synthetic.csv");
const csv = readFileSync(fixturePath, "utf8");
const parsed = parseClzCsv(csv);

function byCore(id: string) {
  const comic = parsed.comics.find((row) => row.coreComicId === id);
  if (!comic) throw new Error(`Missing core comic ${id}`);
  return comic;
}

describe("CLZ CSV import", () => {
  it("requires the official 66-column header, in order", () => {
    expect(CLZ_HEADERS).toHaveLength(66);
    const header = csv.split(/\r?\n/, 1)[0];
    expect(header).toBe(
      'Series,Issue,"Variant Description",Publisher,"Release Date",Format,"Added Date","Issue No.","Cover Date",Barcode,"Story Arc",Grade,"Raw / Slabbed",Key,"Key Category","Key Reason","Purchase Price","Price Sold","CovrPrice Value","Cover Price",Notes,Quantity,"Storage Box",Age,"Core ComicID","Core SeriesID",Country,Crossover,"Full Title",Genre,Imprint,Language,"Release Year","Series Group",Subtitle,Title,Variant,"Cover Year","No. of Pages","Added Year","Bag/Board Date","Bag/Board Year","Collection Status",Index,"Modified Date","My Rating",Owner,Plot,Read,"Read Date","Read Year",Tags,"Custom Label","Grader Notes","Grading Company","Label Type","My Value","Page Quality","Purchase Date","Purchase Store","Purchase Year","Signed by","Slab Certification Number","Sold Date","Sold Year",Value',
    );
    expect(() => parseClzCsv("Series,Issue\nSaga,1\n")).toThrow(ClzParseError);
  });

  it("keeps every original column on every row", () => {
    expect(parsed.comics.length).toBe(30);
    for (const comic of parsed.comics) {
      expect(Object.keys(comic.rawRow)).toEqual([...CLZ_HEADERS]);
      for (const header of CLZ_HEADERS) expect(comic.rawRow).toHaveProperty(header);
    }
  });

  it("keeps barcodes as strings, including leading zeros and a spaced 17-digit UPC", () => {
    const first = byCore("900001");
    expect(first.rawRow.Barcode).toBe("07596060000100001");
    expect(first.barcode).toBe("07596060000100001");
    expect(first.barcode).toHaveLength(17);
    expect(first.barcode?.startsWith("0")).toBe(true);
    expect(String(Number(first.barcode))).not.toBe(first.barcode);

    const spaced = byCore("900002");
    expect(spaced.rawRow.Barcode).toContain(" ");
    expect(spaced.barcode).toBe("07596060000200002");
    expect(spaced.barcode).not.toBe(String(Number(spaced.barcode)));

    expect(byCore("900025").barcode).toBeNull();
    expect(byCore("900025").rawRow.Barcode).toBe("");
  });

  it("parses CLZ dates, null bag/board dates, prices, and whole numbers written as 2020.0", () => {
    const saga = byCore("900001");
    expect(saga.addedDate?.toISOString()).toBe("2020-02-26T12:00:00.000Z");
    expect(saga.bagBoardDate).toBeNull();
    expect(saga.rawRow["Bag/Board Date"]).toBe("0000-00-00");
    expect(saga.releaseYear).toBe(2012);
    expect(saga.rawRow["Release Year"]).toBe("2012.0");
    expect(saga.issueNo).toBe("1");
    expect(saga.rawRow["Issue No."]).toBe("1.0");
    expect(saga.coverDate).toBe("Mar 2012");

    expect(byCore("900011").coverDate).toBe("Jul 2006");
    expect(byCore("900003").bagBoardDate?.toISOString()).toBe("2021-01-02T12:00:00.000Z");
    expect(parseClzDate("0000-00-00")).toBeNull();
    expect(parseClzPrice("$ 4.99")).toBe("4.99");
    expect(byCore("900026").purchasePrice).toBe("4.99");
    expect(byCore("900028").purchasePrice).toBe("1250.00");
    expect(byCore("900028").rawRow["Purchase Price"]).toBe("$ 1,250.00");
    expect(byCore("900027").value).toBe("1200.00");
  });

  it("maps key, slab, quantity, notes, and signatures without dropping text", () => {
    expect(byCore("900001").keyLevel).toBe("Major");
    expect(byCore("900007").keyLevel).toBe("Minor");
    expect(byCore("900008").keyLevel).toBe("No");
    expect(byCore("900001").rawOrSlabbed).toBe("Raw");
    expect(byCore("900009").rawOrSlabbed).toBe("Slabbed");
    expect(byCore("900009").gradingCompany).toBe("CGC");
    expect(byCore("900009").slabCertNumber).toBe("4123456001");
    expect(byCore("900015").signedBy).toBe("Stan Lee");
    expect(byCore("900015").labelType).toBe("Signature Series");
    expect(byCore("900019").quantity).toBe(2);
    expect(byCore("900019").purchasePrice).toBe("5.98");
    expect(costBasis(byCore("900019").purchasePrice, byCore("900019").quantity)).toBe("11.96");
    expect(byCore("900001").notes).toBe('Bought at C2E2, "near mint" copy');
    expect(byCore("900001").rawRow.Notes).toBe('Bought at C2E2, "near mint" copy');
    expect(byCore("900001").rawRow.Tags).toBe("key,first issue");
    expect(byCore("900024").notes).toContain("\n");
    expect(byCore("900006").variant).toBe("B");
  });

  it("rolls spend up as purchase price times quantity", () => {
    const stats = computeStats(parsed.comics);
    const cents = parsed.comics.reduce((sum, comic) => {
      const line = costBasis(comic.purchasePrice, comic.quantity);
      return sum + (line ? Number(line.replace(".", "")) : 0);
    }, 0);
    expect(stats.spend).toBe(cents / 100);

    const unitSum = parsed.comics.reduce((sum, comic) => sum + Number(comic.purchasePrice ?? 0), 0);
    const doubledCopy = byCore("900019");
    expect(stats.spend).toBeCloseTo(unitSum + Number(doubledCopy.purchasePrice), 2);
    expect(costBasis("4.99", 1)).toBe("4.99");
    expect(costBasis(null, 3)).toBeNull();
  });

  it("is idempotent on Core ComicID + variant + index", () => {
    const keys = parsed.comics.map((comic) => comic.dedupeKey);
    expect(new Set(keys).size).toBe(parsed.comics.length);
    expect(byCore("900007").dedupeKey).not.toBe(byCore("900008").dedupeKey);

    const firstPass = planImport(new Set(), parsed.comics);
    expect(firstPass.create).toBe(30);
    expect(firstPass.update).toBe(0);
    expect(firstPass.collapsed).toBe(0);

    const secondPass = planImport(new Set(keys), parsed.comics);
    expect(secondPass.create).toBe(0);
    expect(secondPass.update).toBe(30);

    const duplicate = { ...parsed.comics[0], notes: "replaced on reimport" };
    const merged = mergeByDedupeKey([...parsed.comics, duplicate]);
    expect(merged).toHaveLength(30);
    expect(merged.find((comic) => comic.coreComicId === "900001")?.notes).toBe("replaced on reimport");
    expect(planImport(new Set(), [...parsed.comics, duplicate]).collapsed).toBe(1);
  });
});

describe("Core ComicID 0", () => {
  const zeroPath = path.join(process.cwd(), "fixtures/clz-core-id-zero.csv");
  const zero = parseClzCsv(readFileSync(zeroPath, "utf8"));

  function slammer(overrides: Record<string, string>) {
    return normalizeClzRecord({
      Series: "Planet Slammer",
      Issue: "1",
      "Issue No.": "1.0",
      Variant: "",
      Barcode: "07596060999900001",
      Index: "1.0",
      "Core ComicID": "0",
      "Core SeriesID": "0",
      ...overrides,
    });
  }

  it("does not collapse Planet Slammer #1-#4 onto one comic", () => {
    expect(zero.comics).toHaveLength(4);
    expect(new Set(zero.comics.map((comic) => comic.dedupeKey)).size).toBe(4);
    expect(zero.comics.map((comic) => comic.issueNo)).toEqual(["1", "2", "3", "4"]);
    for (const comic of zero.comics) {
      expect(comic.series).toBe("Planet Slammer");
      expect(comic.coreComicId).toBeNull();
      expect(comic.coreSeriesId).toBeNull();
      expect(comic.rawRow["Core ComicID"]).toBe("0");
      expect(comic.dedupeKey.startsWith("fallback:planet slammer|")).toBe(true);
      expect(comic.dedupeKey).toContain("|07596060999900001|");
    }
    expect(mergeByDedupeKey([...zero.comics, ...zero.comics])).toHaveLength(4);
    expect(planImport(new Set(zero.comics.map((comic) => comic.dedupeKey)), zero.comics)).toMatchObject({
      create: 0,
      update: 4,
      collapsed: 0,
    });
  });

  it("treats 0, blank, and non-numeric ids as missing", () => {
    expect(usableCoreId("0")).toBeNull();
    expect(usableCoreId("0.0")).toBeNull();
    expect(usableCoreId("  ")).toBeNull();
    expect(usableCoreId("n/a")).toBeNull();
    expect(usableCoreId("900001")).toBe("900001");

    const zero = slammer({ "Core ComicID": "0" });
    const zeroDecimal = slammer({ "Core ComicID": "0.0" });
    const blank = slammer({ "Core ComicID": "" });
    const text = slammer({ "Core ComicID": "n/a", Issue: "2", "Issue No.": "2.0" });
    const otherIndex = slammer({ Index: "2.0" });
    const otherVariant = slammer({ Variant: "B" });
    const realId = slammer({ "Core ComicID": "900100" });

    expect(zero.dedupeKey).toBe(zeroDecimal.dedupeKey);
    expect(zero.dedupeKey).toBe(blank.dedupeKey);
    expect(zero.dedupeKey).not.toBe(text.dedupeKey);
    expect(zero.dedupeKey).not.toBe(otherIndex.dedupeKey);
    expect(zero.dedupeKey).not.toBe(otherVariant.dedupeKey);
    expect(realId.dedupeKey).toBe("core:900100|var:|idx:1");
    expect(text.coreComicId).toBeNull();
  });

  it("retires stale core:0 rows onto the fallback key, or removes them when that key already exists", () => {
    const first = slammer({ "Core ComicID": "0" });
    const decimal = slammer({ "Core ComicID": "0.0", Issue: "2", "Issue No.": "2.0", Index: "2.0" });
    expect(legacyZeroCoreKeys(first)).toContain("core:0|var:|idx:1");
    expect(legacyZeroCoreKeys(decimal)).toContain("core:0.0|var:|idx:2");
    expect(isLegacyZeroCoreKey("core:0|var:|idx:1")).toBe(true);
    expect(isLegacyZeroCoreKey("core:0.0|var:b|idx:3")).toBe(true);
    expect(isLegacyZeroCoreKey(first.dedupeKey)).toBe(false);
    expect(legacyZeroCoreKeys(slammer({ "Core ComicID": "900100" }))).toEqual([]);

    const stale = zeroRow("stale-1", "core:0|var:|idx:1", "metron-9.jpg");
    const moved = planZeroIdCleanup([first], [stale], new Set([stale.dedupeKey]));
    expect(moved.retarget).toEqual([{ id: "stale-1", fromKey: "core:0|var:|idx:1", dedupeKey: first.dedupeKey }]);
    expect(moved.remove).toEqual([]);

    const duplicate = planZeroIdCleanup([first], [stale], new Set([stale.dedupeKey, first.dedupeKey]));
    expect(duplicate.retarget).toEqual([]);
    expect(duplicate.remove).toEqual([
      {
        id: "stale-1",
        coverOntoKey: first.dedupeKey,
        cover: {
          coverFile: "metron-9.jpg",
          coverUrl: "/covers/files/metron-9.jpg",
          coverStatus: "matched",
          metronIssueId: "9",
          coverNote: null,
        },
      },
    ]);

    const collapsed = slammer({ Issue: "4", "Issue No.": "4.0" });
    const shared = planZeroIdCleanup([first, collapsed], [{ ...stale, issueNo: "4" }], new Set([stale.dedupeKey]));
    expect(shared.retarget).toEqual([]);
    expect(shared.remove.map((action) => action.coverOntoKey)).toEqual([collapsed.dedupeKey]);

    const unrelated = planZeroIdCleanup([slammer({ "Core ComicID": "900100" })], [stale], new Set([stale.dedupeKey]));
    expect(unrelated.retarget).toEqual([]);
    expect(unrelated.remove).toEqual([]);
  });
});

function zeroRow(id: string, dedupeKey: string, coverFile: string | null): LegacyZeroRow {
  return {
    id,
    dedupeKey,
    series: "Planet Slammer",
    issueNo: "1",
    variant: null,
    coverFile,
    coverUrl: coverFile ? `/covers/files/${coverFile}` : null,
    coverStatus: coverFile ? "matched" : null,
    metronIssueId: coverFile ? "9" : null,
    coverNote: null,
  };
}
