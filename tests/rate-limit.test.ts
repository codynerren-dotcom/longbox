import { describe, expect, it } from "vitest";
import {
  applyMetronHeaders,
  comicVineResource,
  commitMetronSend,
  emptyComicVineRate,
  emptyGcdRate,
  emptyMetronBudget,
  METRON_FALLBACK_BURST,
  METRON_FALLBACK_DAILY,
  METRON_INTERACTIVE_RESERVE,
  METRON_SAFETY_REMAINING,
  normalizeMetronBudget,
  pauseLabel,
  planComicVineAcquire,
  planGcdAcquire,
  planMetronAcquire,
  readMetronRateHeaders,
  sliceAfterCursor,
  type MetronBudget,
} from "@/lib/catalog/rate-limit";

const DAY = "2026-10-15";
const NOW = Date.parse("2026-10-15T19:00:00Z");

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("Metron rate headers", () => {
  it("reads donor limits from headers and pauses while one request is still left", () => {
    const burstReset = Math.floor((NOW + 14 * 60 * 1000) / 1000);
    const sustainedReset = Math.floor((NOW + 86_400_000) / 1000);
    const read = readMetronRateHeaders(
      headers({
        "x-ratelimit-burst-limit": "40",
        "x-ratelimit-burst-remaining": "1",
        "x-ratelimit-burst-reset": String(burstReset),
        "x-ratelimit-sustained-limit": "8000",
        "x-ratelimit-sustained-remaining": "7990",
        "x-ratelimit-sustained-reset": String(sustainedReset),
      }),
      NOW,
    );
    expect(read).toMatchObject({
      burstLimit: 40,
      burstRemaining: 1,
      burstResetAt: burstReset * 1000,
      sustainedLimit: 8000,
      sustainedRemaining: 7990,
      sustainedResetAt: sustainedReset * 1000,
    });

    const applied = applyMetronHeaders(emptyMetronBudget(), headers({
      "x-ratelimit-burst-limit": "40",
      "x-ratelimit-burst-remaining": "1",
      "x-ratelimit-burst-reset": String(burstReset),
      "x-ratelimit-sustained-limit": "8000",
      "x-ratelimit-sustained-remaining": "7990",
      "x-ratelimit-sustained-reset": String(sustainedReset),
    }), NOW);
    expect(applied.sustainedLimit).toBe(8000);
    expect(applied.sustainedLimit).not.toBe(METRON_FALLBACK_DAILY);
    expect(applied.pausedUntil).toBe(burstReset * 1000);
    expect(pauseLabel("Metron", Date.parse("2026-10-15T19:14:00Z"), "America/Chicago")).toBe("Metron paused until 2:14 PM");

    const plan = planMetronAcquire(applied, NOW, "interactive", DAY);
    expect(plan.kind).toBe("pause");
    if (plan.kind === "pause") expect(plan.hold.resumeAt).toBe(burstReset * 1000);
  });

  it("uses 20 per minute and 5000 per day only before the first response", () => {
    const plan = planMetronAcquire(emptyMetronBudget(), NOW, "interactive", DAY);
    expect(plan.kind).toBe("send");
    if (plan.kind !== "send") return;
    const sent = commitMetronSend(plan.state, NOW, DAY);
    expect(sent.count).toBe(1);
    expect(sent.burstLimit).toBeNull();
    const exhausted = { ...sent, count: METRON_FALLBACK_DAILY };
    const held = planMetronAcquire(exhausted, NOW + 3_000, "interactive", DAY);
    expect(held.kind).toBe("pause");
    if (held.kind === "pause") expect(held.hold.budget).toBe("Metron daily");
    expect(METRON_FALLBACK_BURST).toBe(20);
  });
});

describe("rate windows survive a restart", () => {
  it("keeps a Metron pause after the budget is stored and read back", () => {
    const burstReset = NOW + 45_000;
    const paused = applyMetronHeaders(
      { ...emptyMetronBudget(), day: DAY, count: 12 },
      headers({
        "x-ratelimit-burst-limit": "20",
        "x-ratelimit-burst-remaining": "0",
        "x-ratelimit-burst-reset": String(Math.floor(burstReset / 1000)),
        "x-ratelimit-sustained-limit": "8000",
        "x-ratelimit-sustained-remaining": "4000",
        "x-ratelimit-sustained-reset": String(Math.floor((NOW + 86_400_000) / 1000)),
      }),
      NOW,
    );
    const stored = JSON.parse(JSON.stringify(paused)) as unknown;
    const restored = normalizeMetronBudget(stored);
    const plan = planMetronAcquire(restored, NOW + 1_000, "interactive", DAY);
    expect(plan.kind).toBe("pause");
    if (plan.kind === "pause") {
      expect(plan.hold.resumeAt).toBe(Math.floor(burstReset / 1000) * 1000);
      expect(plan.state.sustainedLimit).toBe(8000);
      expect(plan.state.count).toBe(12);
    }
  });

  it("keeps GCD and Comic Vine hits after a JSON round trip", () => {
    let gcd = emptyGcdRate();
    for (let index = 0; index < 30; index += 1) {
      const plan = planGcdAcquire(gcd, NOW + index * 2_000, "anonymous");
      expect(plan.kind).toBe("send");
      if (plan.kind === "send") gcd = plan.state;
    }
    const savedGcd = JSON.parse(JSON.stringify(gcd));
    const held = planGcdAcquire(savedGcd, NOW + 30 * 2_000, "anonymous");
    expect(held.kind).toBe("pause");

    const authed = planGcdAcquire({ ...savedGcd, mode: "anonymous" }, NOW + 30 * 2_000, "authenticated");
    expect(authed.kind).toBe("send");

    let vine = emptyComicVineRate();
    const plan = planComicVineAcquire(vine, NOW, "issues");
    expect(plan.kind).toBe("send");
    if (plan.kind === "send") vine = plan.state;
    const restored = JSON.parse(JSON.stringify(vine));
    const paced = planComicVineAcquire(restored, NOW + 100, "issues");
    expect(paced.kind).toBe("send");
    if (paced.kind === "send") expect(paced.waitMs).toBe(900);
    expect(comicVineResource("/issue/4000-1/")).toBe("issues");
    expect(comicVineResource("/volumes/")).toBe("volumes");
  });
});

describe("interactive reserve", () => {
  it("stops a background job early enough for Match to send three more times", () => {
    let budget: MetronBudget = emptyMetronBudget();
    let now = NOW;
    let backgroundSends = 0;
    for (let index = 0; index < METRON_FALLBACK_BURST; index += 1) {
      const plan = planMetronAcquire(budget, now, "background", DAY);
      if (plan.kind === "pause") break;
      now += plan.waitMs;
      budget = commitMetronSend(plan.state, now, DAY);
      backgroundSends += 1;
      now += 1;
    }
    const backgroundHold = planMetronAcquire(budget, now, "background", DAY);
    expect(backgroundSends).toBe(METRON_FALLBACK_BURST - METRON_INTERACTIVE_RESERVE - METRON_SAFETY_REMAINING);
    expect(backgroundHold.kind).toBe("pause");
    if (backgroundHold.kind === "pause") {
      expect(backgroundHold.hold.budget).toBe("Metron reserve");
      budget = backgroundHold.state;
    }

    let interactiveSends = 0;
    for (let index = 0; index < 5; index += 1) {
      const plan = planMetronAcquire(budget, now, "interactive", DAY);
      if (plan.kind === "pause") break;
      now += plan.waitMs;
      budget = commitMetronSend(plan.state, now, DAY);
      interactiveSends += 1;
      now += 1;
    }
    expect(interactiveSends).toBe(METRON_INTERACTIVE_RESERVE);
    const stopped = planMetronAcquire(budget, now, "interactive", DAY);
    expect(stopped.kind).toBe("pause");
  });
});

describe("job cursor", () => {
  it("continues after the last finished comic", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sliceAfterCursor(rows, null)).toEqual(rows);
    expect(sliceAfterCursor(rows, "a")).toEqual([{ id: "b" }, { id: "c" }]);
    expect(sliceAfterCursor(rows, "missing")).toEqual(rows);
    expect(sliceAfterCursor(rows, "c")).toEqual([]);
  });
});
