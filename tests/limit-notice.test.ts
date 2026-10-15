import { describe, expect, it } from "vitest";
import { GcdBudgetError } from "@/lib/catalog/gcd";
import {
  blocksFromWindows,
  comicVineLimitLabel,
  gcdLimitLabel,
  limitBlockFromError,
  limitNotice,
  limitNotices,
  matchPanelNote,
  metronLimitLabel,
  ComicVineBudgetError,
} from "@/lib/catalog/limit-notice";
import { MetronBudgetError } from "@/lib/covers/types";

const RESET = Date.parse("2026-10-15T16:42:00Z");
const ZONE = "America/Chicago";

describe("manual limit notices", () => {
  it("names the source, the limit, and the Chicago reset time", () => {
    expect(
      limitNotice({ source: "Metron", kind: "limit", limit: "20/min", resumeAt: RESET }, [], ZONE),
    ).toBe("Metron limit reached (20/min). Resets at 11:42 AM.");
    expect(metronLimitLabel("Metron burst", null)).toBe("20/min");
    expect(metronLimitLabel("Metron daily", { sustainedLimit: 8000 })).toBe("8,000/day");
    expect(gcdLimitLabel("GCD hourly")).toBe("30/hour");
    expect(gcdLimitLabel("GCD daily")).toBe("2,000/day");
    expect(comicVineLimitLabel()).toBe("200/hour");
  });

  it("says which other sources were searched", () => {
    const metron = limitBlockFromError(
      new MetronBudgetError("paused", { budget: "Metron burst", resumeAt: RESET, count: 19 }),
    );
    expect(metron?.limit).toBe("20/min");
    expect(limitNotices(metron ? [metron] : [], ["GCD", "Comic Vine"], ZONE)).toBe(
      "Metron limit reached (20/min). Resets at 11:42 AM. GCD and Comic Vine were searched.",
    );

    const gcd = limitBlockFromError(new GcdBudgetError("paused", { budget: "GCD hourly", resumeAt: RESET, count: 30 }));
    expect(limitNotices(gcd ? [gcd] : [], ["Metron"], ZONE)).toBe(
      "GCD limit reached (30/hour). Resets at 11:42 AM. Metron was searched.",
    );

    const vine = limitBlockFromError(new ComicVineBudgetError("paused", { budget: "Comic Vine", resumeAt: RESET, count: 200 }));
    expect(limitNotices(vine ? [vine] : [], [], ZONE)).toBe("Comic Vine limit reached (200/hour). Resets at 11:42 AM.");
  });

  it("names a Metron connect failure and keeps a paused search off the empty-result line", () => {
    const open = limitBlockFromError(
      new MetronBudgetError("paused", { budget: "Metron connect", resumeAt: RESET, count: 3 }),
    );
    expect(limitNotice(open!, [], ZONE)).toBe("Metron unreachable, retrying at 11:42 AM.");
    expect(limitNotices(open ? [open] : [], ["GCD"], ZONE)).toBe(
      "Metron unreachable, retrying at 11:42 AM. GCD was searched.",
    );

    const notice = "Metron limit reached (20/min). Resets at 11:42 AM.";
    expect(matchPanelNote(0, notice)).toBe(notice);
    expect(matchPanelNote(0, null)).toBe("No matches.");
    expect(matchPanelNote(2, null)).toBe("");
  });

  it("reads a paused window and prefers the connect breaker over the rate window", () => {
    const now = RESET - 60_000;
    const blocks = blocksFromWindows({
      now,
      metronPausedUntil: RESET,
      metronBudget: "Metron burst",
      circuitOpenUntil: RESET,
      gcdPausedUntil: null,
      gcdBudget: "GCD hourly",
      comicVinePausedUntil: null,
    });
    expect(limitNotices(blocks, [], ZONE)).toBe("Metron unreachable, retrying at 11:42 AM.");
  });
});
