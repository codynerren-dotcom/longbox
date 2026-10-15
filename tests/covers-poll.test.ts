import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backfillPollPlan, backfillProgressLabel, normalizeBackfillStatus } from "@/lib/covers/poll";

describe("cover backfill progress polling", () => {
  it("updates state in place and stops after leaving Settings when the run is idle", () => {
    expect(backfillPollPlan("/settings", true)).toEqual({ poll: true, navigate: false });
    expect(backfillPollPlan("/settings", false)).toEqual({ poll: true, navigate: false });
    expect(backfillPollPlan("/covers", true)).toEqual({ poll: true, navigate: false });
    expect(backfillPollPlan("/collection", false)).toEqual({ poll: false, navigate: false });
    expect(backfillPollPlan("/logs", false)).toEqual({ poll: false, navigate: false });
  });

  it("keeps a non-navigating poll for the sidebar chip while a run is still going", () => {
    expect(backfillPollPlan("/collection", true)).toEqual({ poll: true, navigate: false });
    expect(backfillProgressLabel({ running: true, matched: 4, unmatched: 1 })).toBe("Covers running · 4 matched · 1 unmatched");
    expect(backfillProgressLabel({ running: true, matched: 3, unmatched: 0, skipped: 2, task: "enrich" })).toBe(
      "Metron details · 3 filled · 2 unchanged",
    );
    expect(backfillProgressLabel({ running: false, matched: 4, unmatched: 1 })).toBeNull();
  });

  it("drops redirect fields from a status payload", () => {
    const status = normalizeBackfillStatus({
      running: true,
      matched: 2,
      unmatched: 1,
      redirect: "/settings",
      href: "/settings",
    });
    expect(status?.running).toBe(true);
    expect(status?.matched).toBe(2);
    expect(JSON.stringify(status)).not.toContain("/settings");
  });

  it("does not meta-refresh Settings or Covers", () => {
    const settings = readFileSync("src/app/settings/page.tsx", "utf8");
    const covers = readFileSync("src/app/covers/page.tsx", "utf8");
    expect(settings).not.toContain("httpEquiv");
    expect(settings).not.toContain("http-equiv");
    expect(covers).not.toContain("httpEquiv");
    expect(covers).not.toContain("http-equiv");
  });
});
