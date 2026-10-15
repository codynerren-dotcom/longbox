import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unlinkUpdate } from "@/lib/catalog/link-plan";
import { ISSUE_FIELDS, toIssueDraft } from "@/lib/issue-fields";
import { blankIssueRaw, conflictMessage, holdUserEdits, planIssueEdit, type IssueChoiceLists } from "@/lib/issue-edit";
import { isEmptyDisplay, showSlabSection } from "@/lib/issue-view";

const lists: IssueChoiceLists = {
  categories: ["First appearance", "First issue"],
  companies: ["CGC", "CBCS", "PGX"],
  rawOrSlabbed: ["Raw", "Slabbed"],
  keyLevels: ["No", "Minor", "Major"],
};

const CLZ_KEYS = [
  "series",
  "issue",
  "variantDescription",
  "publisher",
  "releaseDate",
  "format",
  "addedDate",
  "issueNo",
  "coverDate",
  "barcode",
  "storyArc",
  "grade",
  "rawOrSlabbed",
  "keyLevel",
  "keyCategory",
  "keyReason",
  "purchasePrice",
  "priceSold",
  "covrPriceValue",
  "coverPrice",
  "notes",
  "quantity",
  "storageBox",
  "age",
  "coreComicId",
  "coreSeriesId",
  "country",
  "crossover",
  "fullTitle",
  "genre",
  "imprint",
  "language",
  "releaseYear",
  "seriesGroup",
  "subtitle",
  "title",
  "variant",
  "coverYear",
  "pageCount",
  "addedYear",
  "bagBoardDate",
  "bagBoardYear",
  "collectionStatus",
  "clzIndex",
  "modifiedDate",
  "myRating",
  "owner",
  "plot",
  "read",
  "readDate",
  "readYear",
  "tags",
  "customLabel",
  "graderNotes",
  "gradingCompany",
  "labelType",
  "myValue",
  "pageQuality",
  "purchaseDate",
  "purchaseStore",
  "purchaseYear",
  "signedBy",
  "slabCertNumber",
  "soldDate",
  "soldYear",
  "value",
];

describe("issue edit", () => {
  it("exposes every CLZ column", () => {
    const keys = new Set<string>(ISSUE_FIELDS.map((field) => field.key));
    for (const key of CLZ_KEYS) expect(keys.has(key)).toBe(true);
  });

  it("rejects a blank series, a bad price, a bad date, and a rating over 10", () => {
    const parsed = planIssueEdit(
      { quantity: 1, read: false },
      blankIssueRaw({ series: "  ", purchasePrice: "nope", releaseDate: "2012-13-40", myRating: "11", quantity: "0" }),
      {},
      lists,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const fields = parsed.errors.map((error) => error.field);
    expect(fields).toContain("series");
    expect(fields).toContain("purchasePrice");
    expect(fields).toContain("releaseDate");
    expect(fields).toContain("myRating");
    expect(fields).toContain("quantity");
  });

  it("marks only the fields that changed and keeps a Metron source on the rest", () => {
    const current = {
      series: "Saga",
      issueNo: "1",
      quantity: 1,
      read: false,
      grade: "9.8",
      title: "Chapter One",
      plot: "Already named",
      purchasePrice: { toString: () => "9.99" },
      purchaseDate: new Date("2020-02-26T12:00:00.000Z"),
      purchaseYear: 2020,
      rawOrSlabbed: "Raw",
      storageBox: "Longbox A",
    };
    const planned = planIssueEdit(
      current,
      blankIssueRaw({
        series: "Saga",
        issueNo: "1",
        grade: "9.6",
        title: "Chapter One",
        plot: "",
        purchasePrice: "9.99",
        purchaseDate: "2020-02-26",
        rawOrSlabbed: "Raw",
        storageBox: "Longbox A",
        quantity: "1",
        read: "false",
      }),
      { title: "metron", plot: "metron" },
      lists,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.changed).toEqual(["Grade", "Plot"]);
    expect(planned.data.grade).toBe("9.6");
    expect(planned.data.plot).toBeNull();
    expect(planned.data).not.toHaveProperty("series");
    expect(planned.data).not.toHaveProperty("purchasePrice");
    expect(planned.sources.title).toBe("metron");
    expect(planned.sources.plot).toBe("user");
    expect(planned.sources.grade).toBe("user");
  });

  it("derives a blank purchase year from the purchase date", () => {
    const planned = planIssueEdit(
      { series: "Saga", quantity: 1, read: false },
      blankIssueRaw({ series: "Saga", purchaseDate: "2020-02-26", quantity: "1" }),
      {},
      lists,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.data.purchaseYear).toBe(2020);
    expect(planned.changed).toContain("Purchase date");
    expect(planned.changed).toContain("Purchase year");
    expect(planned.sources.purchaseDate).toBe("user");
    expect(planned.sources.purchaseYear).toBe("user");
  });

  it("skips a conflicting CLZ value and leaves a matching one quiet", () => {
    const update = {
      series: "Batman",
      seriesSort: "batman",
      grade: "9.8",
      title: "Chapter One",
      purchasePrice: "9.99",
    };
    const held = holdUserEdits(
      update,
      { series: "Saga", grade: "9.6", title: "Chapter One", purchasePrice: { toString: () => "9.99" } },
      { series: "user", grade: "user", title: "user", purchasePrice: "user" },
    );
    expect(held.update).not.toHaveProperty("series");
    expect(held.update).not.toHaveProperty("seriesSort");
    expect(held.update).not.toHaveProperty("grade");
    expect(held.update).not.toHaveProperty("title");
    expect(held.update).not.toHaveProperty("purchasePrice");
    expect(held.conflicts.map((conflict) => conflict.field)).toEqual(["series", "grade"]);
    expect(conflictMessage("Saga", "1", held.conflicts)).toBe("CLZ re-import skipped user edits on Saga #1: Series, Grade.");
  });

  it("keeps user marks when a catalog id is unlinked", () => {
    const data = unlinkUpdate({
      source: "metron",
      fieldSources: { metronIssueId: "metron", plot: "metron", grade: "user", series: "user" },
      manualLink: null,
    });
    expect(data.fieldSources).toEqual({ plot: "metron", grade: "user", series: "user" });
  });

  it("serializes dates and prices for the form", () => {
    const draft = toIssueDraft({
      id: "c1",
      series: "Saga",
      quantity: 1,
      read: true,
      purchasePrice: { toString: () => "9.99" },
      purchaseDate: new Date("2020-02-26T12:00:00.000Z"),
      myRating: { toString: () => "5" },
    });
    expect(draft.values.series).toBe("Saga");
    expect(draft.values.quantity).toBe("1");
    expect(draft.values.read).toBe("true");
    expect(draft.values.purchasePrice).toBe("9.99");
    expect(draft.values.purchaseDate).toBe("2020-02-26");
    expect(draft.values.myRating).toBe("5");
    expect(draft.values.notes).toBe("");
  });
});

describe("issue view", () => {
  it("hides blank facts and the slab block on a raw copy", () => {
    expect(isEmptyDisplay(null)).toBe(true);
    expect(isEmptyDisplay("  ")).toBe(true);
    expect(isEmptyDisplay("—")).toBe(true);
    expect(isEmptyDisplay("9.8")).toBe(false);
    expect(isEmptyDisplay(0)).toBe(false);
    expect(showSlabSection("Raw")).toBe(false);
    expect(showSlabSection("Slabbed")).toBe(true);
    const page = readFileSync("src/app/issues/[id]/page.tsx", "utf8");
    const form = readFileSync("src/app/issues/edit-form.tsx", "utf8");
    const fields = readFileSync("src/lib/issue-fields.ts", "utf8");
    expect(page).toContain("isEmptyDisplay");
    expect(page).toContain("showSlabSection");
    expect(page).not.toContain("—");
    expect(page).not.toContain("No plot on this copy.");
    expect(page).not.toContain("Raw copy");
    expect(form).toContain("Edit");
    expect(form).toContain("Save");
    expect(form).toContain("Cancel");
    expect(form).toContain("will not replace them");
    expect(fields).toContain('label: "Storage box"');
    expect(fields).toContain('label: "Certification number"');
    expect(fields).toContain('label: "My rating"');
    expect(fields).toContain('label: "Grader notes"');
  });
});
