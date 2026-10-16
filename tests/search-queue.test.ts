import { describe, expect, it } from "vitest";
import {
  alreadyQueuedMessage,
  applyAttempt,
  cancelQueueItem,
  dueQueue,
  enqueueInto,
  hintFromBlocks,
  queueResultHref,
  queueResultMessage,
  queuedLogHref,
  queuedMessage,
  runOrder,
  type QueueRecord,
} from "@/lib/catalog/search-queue";

const ZONE = "America/Chicago";
const RESET = Date.parse("2026-10-15T16:42:00Z");
const LATER = RESET + 60_000;

function row(partial: Partial<QueueRecord> & Pick<QueueRecord, "id" | "comicId" | "source">): QueueRecord {
  return {
    kind: "search",
    label: "Amazing Fantasy #15",
    resumeAt: RESET,
    createdAt: 1,
    payload: {},
    ...partial,
  };
}

describe("search queue", () => {
  it("refuses a second queue of the same comic and source", () => {
    const first = enqueueInto([], {
      id: "a",
      comicId: "c1",
      source: "gcd",
      kind: "search",
      label: "Amazing Fantasy #15",
      resumeAt: RESET,
      createdAt: 1,
    });
    const second = enqueueInto(first.rows, {
      id: "b",
      comicId: "c1",
      source: "gcd",
      kind: "relink",
      label: "Amazing Fantasy #15",
      resumeAt: LATER,
      createdAt: 2,
    });
    expect(first.status).toBe("added");
    expect(second.status).toBe("duplicate");
    expect(second.rows).toHaveLength(1);
    expect(second.row.id).toBe("a");
    expect(second.row.resumeAt).toBe(RESET);
    expect(second.row.kind).toBe("search");
  });

  it("allows the same comic on a different source", () => {
    const gcd = enqueueInto([], {
      comicId: "c1",
      source: "gcd",
      kind: "search",
      label: "Amazing Fantasy #15",
      resumeAt: RESET,
    });
    const metron = enqueueInto(gcd.rows, {
      comicId: "c1",
      source: "metron",
      kind: "search",
      label: "Amazing Fantasy #15",
      resumeAt: LATER,
    });
    expect(metron.status).toBe("added");
    expect(metron.rows.map((item) => item.source)).toEqual(["gcd", "metron"]);
  });

  it("runs due rows in resume order, then queue order", () => {
    const rows = [
      row({ id: "late", comicId: "c1", source: "gcd", resumeAt: LATER, createdAt: 1 }),
      row({ id: "second", comicId: "c2", source: "metron", resumeAt: RESET, createdAt: 5 }),
      row({ id: "first", comicId: "c3", source: "comicvine", resumeAt: RESET, createdAt: 2 }),
    ];
    expect(dueQueue(rows, RESET).map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("runs a queued search before a background job at the same time", () => {
    const ordered = runOrder([
      { at: LATER, lane: "queue" },
      { at: RESET, lane: "background" },
      { at: RESET, lane: "queue" },
    ]);
    expect(ordered).toEqual([
      { at: RESET, lane: "queue" },
      { at: RESET, lane: "background" },
      { at: LATER, lane: "queue" },
    ]);
  });

  it("names a match with a comic link, and an empty search", () => {
    const item = row({ id: "a", comicId: "c1", source: "gcd" });
    expect(queueResultMessage(item, "matched")).toBe("Matched Amazing Fantasy #15 on GCD.");
    expect(queueResultHref("c1")).toBe("/issues/c1");
    expect(queueResultMessage(item, "empty")).toBe("No matches for Amazing Fantasy #15 on GCD.");
    expect(queueResultMessage(item, "proposed")).toBe("Proposed a match for Amazing Fantasy #15 on GCD. Review it before linking.");
    expect(queuedLogHref({ queued: true, comicId: "c1", href: "/issues/c1" })).toBe("/issues/c1");
    expect(queuedLogHref({ comicId: "c1" })).toBeNull();
  });

  it("keeps a paused row and drops a finished one with a notice", () => {
    const rows = [row({ id: "a", comicId: "c1", source: "metron" }), row({ id: "b", comicId: "c2", source: "gcd" })];
    const paused = applyAttempt(rows, "a", { status: "paused", resumeAt: LATER });
    expect(paused.notice).toBeNull();
    expect(paused.rows.find((item) => item.id === "a")?.resumeAt).toBe(LATER);
    expect(paused.rows).toHaveLength(2);

    const matched = applyAttempt(paused.rows, "a", { status: "matched" });
    expect(matched.notice).toBe("Matched Amazing Fantasy #15 on Metron.");
    expect(matched.rows.map((item) => item.id)).toEqual(["b"]);

    const empty = applyAttempt(matched.rows, "b", { status: "empty" });
    expect(empty.notice).toBe("No matches for Amazing Fantasy #15 on GCD.");
    expect(empty.rows).toEqual([]);
  });

  it("cancels one queued search and leaves the rest", () => {
    const rows = [row({ id: "a", comicId: "c1", source: "gcd" }), row({ id: "b", comicId: "c2", source: "gcd" })];
    const cancelled = cancelQueueItem(rows, "a");
    expect(cancelled.removed?.id).toBe("a");
    expect(cancelled.rows.map((item) => item.id)).toEqual(["b"]);
    expect(cancelQueueItem(cancelled.rows, "missing").removed).toBeNull();
  });

  it("queues the source Cody asked for, and says when it runs", () => {
    expect(
      hintFromBlocks("gcd", [
        { source: "Metron", resumeAt: LATER },
        { source: "GCD", resumeAt: RESET },
      ], "search"),
    ).toEqual({ source: "gcd", resumeAt: RESET, kind: "search" });
    expect(queuedMessage(RESET, ZONE)).toBe("Queued. Runs at 11:42 AM.");
    expect(alreadyQueuedMessage({ label: "Amazing Fantasy #15", source: "gcd", resumeAt: RESET }, ZONE)).toBe(
      "Already queued for Amazing Fantasy #15 on GCD. Runs at 11:42 AM.",
    );
  });
});
