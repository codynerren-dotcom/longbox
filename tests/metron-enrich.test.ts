import { describe, expect, it } from "vitest";
import { isBlank, mapMetronDetails, planEnrichment, protectMetronFields, fromMetron } from "@/lib/covers/enrich";

const payload = {
  id: 50,
  series: { id: 15, name: "Saga", volume: 1, year_began: 2012, publisher: { id: 2, name: "Image" } },
  number: "1",
  title: "Saga",
  name: ["Chapter One"],
  cover_date: "2012-03-01",
  store_date: "2012-03-14",
  price: "2.99",
  upc: "70985300000100111",
  page: 44,
  desc: "Alana and Marko run.",
  image: "http://static.metron.cloud/saga-1.jpg",
  arcs: [{ id: 3, name: "Volume One" }, { id: 4, name: "Volume One" }],
  credits: [
    { creator: "Brian K. Vaughan", role: [{ name: "Writer" }] },
    { creator: { name: "Fiona Staples" }, role: [{ name: "Artist" }, { name: "Cover" }] },
    { creator: "Someone", role: [{ name: "Inker" }] },
  ],
  characters: [{ name: "Marko" }, { name: "Alana" }],
  teams: [{ name: "The Narrative" }],
  imprint: { name: "Skybound" },
};

describe("Metron issue details", () => {
  it("maps one issue payload into blank-fill fields", () => {
    const detail = mapMetronDetails(payload);
    expect(detail?.imageUrl).toBe("https://static.metron.cloud/saga-1.jpg");
    expect(detail?.title).toBe("Chapter One");
    expect(detail?.seriesName).toBe("Saga");
    expect(detail?.coverDate).toBe("2012-03-01");
    expect(detail?.coverYear).toBe(2012);
    expect(detail?.releaseDate?.toISOString()).toBe("2012-03-14T00:00:00.000Z");
    expect(detail?.storyArc).toBe("Volume One");
    expect(detail?.plot).toBe("Alana and Marko run.");
    expect(detail?.pageCount).toBe(44);
    expect(detail?.coverPrice).toBe("2.99");
    expect(detail?.barcode).toBe("70985300000100111");
    expect(detail?.writer).toBe("Brian K. Vaughan");
    expect(detail?.artist).toBe("Fiona Staples");
    expect(detail?.coverArtist).toBe("Fiona Staples");
    expect(detail?.characters).toBe("Marko, Alana");
    expect(detail?.teams).toBe("The Narrative");
    expect(detail?.imprint).toBe("Skybound");
    expect(detail?.seriesYear).toBe(2012);
    expect(detail?.seriesVolume).toBe(1);
    expect(detail?.id).toBe("50");
    expect(detail?.seriesId).toBe("15");
  });

  it("treats zero pages and a zero cover price as empty", () => {
    const detail = mapMetronDetails({ ...payload, page: 0, price: "0.00", title: "  ", name: [] });
    expect(detail?.pageCount).toBeNull();
    expect(detail?.coverPrice).toBeNull();
    expect(detail?.title).toBeNull();
  });
});

describe("enrichment plan", () => {
  const detail = mapMetronDetails(payload);
  if (!detail) throw new Error("fixture did not map");

  it("fills only blank fields and records those sources", () => {
    const plan = planEnrichment(
      {
        title: "My title",
        plot: "Already written",
        barcode: "111",
        writer: "Someone else",
        pageCount: 0,
        coverPrice: { toString: () => "0.00" },
        coverDate: "   ",
      },
      detail,
      { plot: "metron" },
    );
    expect(plan.patch.title).toBeUndefined();
    expect(plan.patch.plot).toBeUndefined();
    expect(plan.patch.barcode).toBeUndefined();
    expect(plan.patch.writer).toBeUndefined();
    expect(plan.patch.pageCount).toBe(44);
    expect(plan.patch.coverPrice).toBe("2.99");
    expect(plan.patch.coverDate).toBe("2012-03-01");
    expect(plan.patch.metronIssueId).toBe("50");
    expect(plan.filled).toContain("pageCount");
    expect(plan.filled).not.toContain("title");
    expect(plan.filled).not.toContain("plot");
    expect(plan.sources.plot).toBe("metron");
    expect(plan.sources.pageCount).toBe("metron");
    expect(plan.sources.title).toBeUndefined();
    expect(fromMetron(plan.sources, "coverDate")).toBe(true);
    expect(fromMetron(plan.sources, "writer")).toBe(false);
  });

  it("treats whitespace as empty", () => {
    expect(isBlank("writer", "  ")).toBe(true);
    expect(isBlank("writer", "Kelly")).toBe(false);
    expect(isBlank("pageCount", 0)).toBe(true);
    expect(isBlank("coverPrice", "0")).toBe(true);
  });
});

describe("CLZ updates", () => {
  it("omits empty enrichable fields and drops the Metron flag when CLZ has a value", () => {
    const update = {
      title: "CLZ title",
      plot: null,
      barcode: "   ",
      pageCount: 0,
      coverPrice: "0.00",
      coverDate: "Mar 2012",
      grade: null,
      series: "Saga",
    };
    const guarded = protectMetronFields(update, {
      title: "metron",
      plot: "metron",
      writer: "metron",
      coverDate: "metron",
    });
    expect(guarded.update.title).toBe("CLZ title");
    expect(guarded.update).not.toHaveProperty("plot");
    expect(guarded.update).not.toHaveProperty("barcode");
    expect(guarded.update).not.toHaveProperty("pageCount");
    expect(guarded.update).not.toHaveProperty("coverPrice");
    expect(guarded.update.coverDate).toBe("Mar 2012");
    expect(guarded.update.grade).toBeNull();
    expect(guarded.update.series).toBe("Saga");
    expect(guarded.changedSources).toBe(true);
    expect(guarded.sources).toEqual({ plot: "metron", writer: "metron" });
  });
});
