import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetPauseMessage } from "@/lib/covers/budget-pause";
import { includeInRematch, rematchRunPlan } from "@/lib/covers/edition";
import { addMiss, armEditionPause, comicsAfterCursor, EDITION_STALE_MS, editionRunBlocks, editionRunStale, editionSummaryText, missCategory, nextResumeWake } from "@/lib/covers/edition-job";
import { editionOutcome, runFacsimilePass } from "@/lib/covers/facsimile-once";
import { acquireEditionRematchLock, armJobResume, editionRematchLockHeld, guardEditionPass, releaseEditionRematchLock } from "@/lib/covers/facsimile-rematch";
import { editionJobText, writeEditionJob } from "@/lib/covers/job-state";
import { budgetDay, nextBudgetDayStart } from "@/lib/covers/limiter";
import { keptPrintingCover } from "@/lib/covers/printing-cover";

describe("edition re-match budget pause", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the budget, the request count, and the resume time", () => {
    const now = Date.parse("2026-10-16T02:46:00.000Z");
    const resumeAt = nextBudgetDayStart(now, "America/Chicago");
    expect(budgetDay(new Date(now), "America/Chicago")).toBe("2026-10-15");
    expect(budgetDay(new Date(resumeAt), "America/Chicago")).toBe("2026-10-16");
    expect(budgetDay(new Date(resumeAt - 2_000), "America/Chicago")).toBe("2026-10-15");
    const message = budgetPauseMessage("Edition re-match", { budget: "Metron daily", count: 2387, resumeAt });
    expect(message).toContain("Metron daily");
    expect(message).toContain("2387 requests");
    expect(message).toContain("Resumes at");
    expect(message).not.toContain("\u2014");
  });

  it("resumes on a timer without waiting for another page load", () => {
    const timers: Array<{ ms: number; fire: () => void }> = [];
    let started = 0;
    armJobResume(90_000, () => {
      started += 1;
    }, (ms, fire) => {
      timers.push({ ms, fire });
    });
    expect(started).toBe(0);
    expect(timers.map((timer) => timer.ms)).toEqual([90_000]);
    timers[0]?.fire();
    expect(started).toBe(1);
    const source = readFileSync("src/lib/covers/facsimile-rematch.ts", "utf8");
    expect(source).toContain("armJobResume");
    expect(source).toContain("scheduleFacsimileRematch");
    expect(readFileSync("src/instrumentation.ts", "utf8")).toContain("scheduleFacsimileRematch");
  });

  it("resumes a budget pause on a fake timer and fails loudly when the timer cannot arm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T04:47:28.000Z"));
    let resumed = 0;
    const armed = armEditionPause({
      now: Date.now(),
      resumeAt: Date.now() + 5_000,
      schedule: (ms, fire) => {
        setTimeout(fire, ms);
      },
      onResume: () => {
        resumed += 1;
      },
    });
    expect(armed).toEqual({ ok: true });
    vi.advanceTimersByTime(4_999);
    expect(resumed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(resumed).toBe(1);

    const failed = armEditionPause({
      now: Date.now(),
      resumeAt: Date.now() + 5_000,
      schedule: () => {
        throw new Error("timer unavailable");
      },
      onResume: () => {
        resumed += 1;
      },
    });
    expect(failed).toEqual({ ok: false, message: "timer unavailable" });
    expect(armEditionPause({ now: Date.now(), resumeAt: Number.NaN, schedule: () => undefined, onResume: () => undefined })).toEqual({
      ok: false,
      message: "Edition re-match pause had no resume time.",
    });
  });

  it("marks a run with no progress for 10 minutes stale, and a stale run does not block", () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-17T04:47:28.000Z");
    vi.setSystemTime(start);
    const running = {
      state: "running" as const,
      message: "Edition re-match paused for the Metron job budget.",
      resumeAt: new Date(start + 5_000).toISOString(),
      metronResumeAt: new Date(start + 5_000).toISOString(),
      matched: 2,
      unmatched: 1,
      updatedAt: new Date(start).toISOString(),
      attempted: 4,
      proposed: 2,
      noCandidate: 1,
      skipped: 1,
      cursorId: "comic-4",
      heartbeatAt: new Date(start).toISOString(),
      runId: "run",
      mode: "propose" as const,
      scope: "suspect" as const,
      misses: { "no-issue": 1 },
    };
    expect(editionRunStale(running, start + EDITION_STALE_MS)).toBe(false);
    expect(editionRunBlocks(running, start + EDITION_STALE_MS)).toBe(true);
    vi.advanceTimersByTime(EDITION_STALE_MS + 1);
    expect(editionRunStale(running, Date.now())).toBe(true);
    expect(editionRunBlocks(running, Date.now())).toBe(false);
    expect(nextResumeWake({ inflight: true, resumeAt: start + 5_000, now: Date.now(), postponedFrom: start }).kind).toBe("stale");
    expect(nextResumeWake({ inflight: false, resumeAt: start + 5_000, now: Date.now(), postponedFrom: null })).toEqual({ kind: "resume" });
    expect(nextResumeWake({ inflight: false, resumeAt: Number.NaN, now: Date.now(), postponedFrom: null })).toMatchObject({ kind: "error" });
    expect(comicsAfterCursor([{ id: "a" }, { id: "comic-4" }, { id: "b" }], "comic-4").map((row) => row.id)).toEqual(["b"]);
    expect(editionSummaryText(running)).toBe("Attempted 4. Proposed 2. No candidate 1. Misses: no-issue 1.");
    const shelf = [
      { id: "tight", manual: false, suspect: false },
      { id: "suspect", manual: false, suspect: true },
      { id: "hand", manual: true, suspect: true },
      { id: "loose", manual: false, suspect: true },
    ];
    const pick = (scope: "suspect" | "full") => shelf.filter((row) => includeInRematch({ scope, manual: row.manual, suspect: row.suspect }));
    const suspects = pick("suspect");
    expect(suspects.map((row) => row.id)).toEqual(["suspect", "loose"]);
    expect(comicsAfterCursor(suspects, null).map((row) => row.id)).toEqual(["suspect", "loose"]);
    expect(pick("full").map((row) => row.id)).toEqual(["tight", "suspect", "loose"]);
    expect(rematchRunPlan({ resume: true, existing: { state: "paused", scope: "suspect" } })).toEqual({ resume: true, scope: "suspect" });
    expect(rematchRunPlan({ requested: "full", existing: { state: "paused", scope: "suspect" } })).toEqual({ resume: false, scope: "full" });
    expect(rematchRunPlan({ requested: "full", existing: { state: "paused", scope: "full" } })).toEqual({ resume: true, scope: "full" });
    expect(rematchRunPlan({ requested: "suspect", existing: null })).toEqual({ resume: false, scope: "suspect" });
    expect(rematchRunPlan({ resume: true, existing: null })).toEqual({ resume: false, scope: "suspect" });
    expect(missCategory("not on Metron (no collected-edition series)")).toBe("not-on-metron");
    expect(addMiss({}, "No Metron issue for Saga.")).toEqual({ "no-issue": 1 });
  });

  it("keeps later copies on GCD after the Metron budget is exhausted", async () => {
    const calls: Array<{ id: string; metron: boolean }> = [];
    const summary = await runFacsimilePass({
      already: async () => false,
      markDone: async () => {
        throw new Error("deferred copies are not done");
      },
      ids: async () => [
        { id: "first", manual: false },
        { id: "gcd-only", manual: false },
      ],
      rematch: async (id, ctx) => {
        const metron = ctx?.metron !== false;
        calls.push({ id, metron });
        if (id === "first") return "deferred";
        return "matched";
      },
    });
    expect(calls).toEqual([
      { id: "first", metron: true },
      { id: "gcd-only", metron: false },
    ]);
    expect(summary).toMatchObject({ matched: 1, deferred: 1, done: false });
    expect(editionOutcome({ matched: false, metronSkipped: true, gcdTried: false })).toBe("metron-budget");
    expect(editionOutcome({ matched: true, metronSkipped: true, gcdTried: true })).toBe("matched");
    expect(editionOutcome({ matched: false, metronSkipped: true, gcdTried: true })).toBe("deferred");
    expect(editionOutcome({ matched: false, metronSkipped: false, gcdTried: true })).toBe("unmatched");
  });

  it("shows running, paused until a time, and finished", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "longbox-job-"));
    const resumeAt = new Date("2026-10-16T05:00:00.000Z").toISOString();
    expect(editionJobText(null)).toBeNull();
    expect(editionJobText(writeEditionJob({ state: "running", message: null, resumeAt: null, metronResumeAt: null, matched: 1, unmatched: 0 }, dir))).toBe(
      "Edition re-match: running",
    );
    const paused = editionJobText(
      writeEditionJob({ state: "paused", message: null, resumeAt, metronResumeAt: resumeAt, matched: 2, unmatched: 1 }, dir),
    );
    expect(paused).toMatch(/^Edition re-match: paused until /);
    expect(editionJobText(writeEditionJob({ state: "finished", message: null, resumeAt: null, metronResumeAt: null, matched: 3, unmatched: 1 }, dir))).toBe(
      "Edition re-match: finished",
    );
    const settings = readFileSync("src/components/backfill-status.tsx", "utf8");
    const logs = readFileSync("src/app/logs/page.tsx", "utf8");
    expect(settings).toContain('from "@/lib/covers/edition-job"');
    expect(settings).not.toContain('from "@/lib/covers/job-state"');
    expect(readFileSync("src/lib/covers/job-state.ts", "utf8")).toContain('import "server-only"');
    expect(readFileSync("src/lib/covers/files.ts", "utf8")).toContain('import "server-only"');
    expect(logs).toContain("editionJobText");
    expect(settings).not.toContain("\u2014");
    expect(logs).not.toContain("\u2014");
  });

  it("lets one edition pass hold the lock and writes the marker only after that pass", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "longbox-edition-lock-"));
    let marks = 0;
    let started = 0;
    const finished = await guardEditionPass(dir, async () => marks > 0, async () => {
      started += 1;
      expect(editionRematchLockHeld(dir)).toBe(true);
      const overlapped = await guardEditionPass(dir, async () => false, async () => {
        started += 1;
        return true;
      });
      expect(overlapped).toBe(false);
      expect(started).toBe(1);
      marks += 1;
      return true;
    });
    expect(finished).toBe(true);
    expect(marks).toBe(1);
    expect(editionRematchLockHeld(dir)).toBe(false);
    const skipped = await guardEditionPass(dir, async () => marks > 0, async () => {
      throw new Error("the finished marker should stop a second pass");
    });
    expect(skipped).toBe(true);

    expect(acquireEditionRematchLock(dir)).toBe(true);
    expect(acquireEditionRematchLock(dir)).toBe(false);
    const stale = path.join(dir, "edition-rematch.lock");
    utimesSync(stale, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 3 * 60 * 60 * 1000));
    expect(acquireEditionRematchLock(dir)).toBe(true);
    releaseEditionRematchLock(dir);
    writeFileSync(stale, "2147483646\n0\n");
    expect(editionRematchLockHeld(dir)).toBe(false);
    expect(acquireEditionRematchLock(dir)).toBe(true);
    releaseEditionRematchLock(dir);
    expect(readFileSync("src/lib/covers/facsimile-once.ts", "utf8")).toContain("await deps.markDone()");
  });

  it("keeps the existing cover until a printing replacement exists", () => {
    expect(keptPrintingCover("metron-old.jpg", null, "No 2nd printing cover on this issue.")).toEqual({
      coverFile: "metron-old.jpg",
      coverUrl: "/covers/files/metron-old.jpg",
      coverNote: "Needs review. No 2nd printing cover on this issue.",
    });
    expect(keptPrintingCover("metron-old.jpg", "metron-second.jpg", "No 2nd printing cover on this issue.")).toEqual({
      coverFile: "metron-second.jpg",
      coverUrl: "/covers/files/metron-second.jpg",
      coverNote: null,
    });
    expect(keptPrintingCover(null, null, "Needs review. Already marked.")).toMatchObject({
      coverFile: null,
      coverNote: "Needs review. Already marked.",
    });
  });
});
