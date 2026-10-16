import { describe, expect, it } from "vitest";
import { computeStats, topSeriesLabel } from "@/lib/stats";
import type { StatsComic } from "@/lib/stats";

function row(overrides: Partial<StatsComic> & Pick<StatsComic, "series" | "issueNo">): StatsComic {
  return {
    quantity: 1,
    publisher: "Image",
    keyLevel: null,
    rawOrSlabbed: null,
    coverYear: 2019,
    purchasePrice: null,
    ...overrides,
  };
}

describe("shelf stats", () => {
  it("counts cover variants of one number as one comic", () => {
    const stats = computeStats([
      row({ series: "Something is Killing the Children", issueNo: "1", quantity: 1 }),
      row({ series: "Something is Killing the Children", issueNo: "1", quantity: 1 }),
      row({ series: "Paper Girls", issueNo: "1", quantity: 2 }),
      row({ series: "Paper Girls", issueNo: "2", quantity: 1 }),
      row({ series: "Saga", issueNo: "8", quantity: 1 }),
    ]);

    expect(stats.comics).toBe(4);
    expect(stats.copies).toBe(6);
    expect(stats.topSeries).toEqual([
      { label: "Paper Girls", count: 2, copies: 3 },
      { label: "Something is Killing the Children", count: 1, copies: 2 },
      { label: "Saga", count: 1, copies: 1 },
    ]);
    expect(topSeriesLabel(1, 2)).toBe("1 comic · 2 copies");
    expect(topSeriesLabel(6, 6)).toBe("6 comics · 6 copies");
  });

  it("folds a lettered suffix into the base issue", () => {
    const stats = computeStats([
      row({ series: "Fantastic Four", issueNo: "3G" }),
      row({ series: "Fantastic Four", issueNo: "3H" }),
      row({ series: "Fantastic Four", issueNo: "10C" }),
    ]);
    expect(stats.comics).toBe(2);
    expect(stats.copies).toBe(3);
    expect(stats.topSeries[0]).toMatchObject({ count: 2, copies: 3 });
    expect(topSeriesLabel(2, 3)).toBe("2 comics · 3 copies");
  });
});
