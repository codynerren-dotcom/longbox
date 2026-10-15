import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { budgetPauseMessage } from "@/lib/covers/budget-pause";
import { editionOutcome, runFacsimilePass } from "@/lib/covers/facsimile-once";
import { armJobResume } from "@/lib/covers/facsimile-rematch";
import { editionJobText, writeEditionJob } from "@/lib/covers/job-state";
import { budgetDay, nextBudgetDayStart } from "@/lib/covers/limiter";
import { keptPrintingCover } from "@/lib/covers/printing-cover";
import { readFileSync } from "node:fs";

describe("edition re-match budget pause", () => {
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
