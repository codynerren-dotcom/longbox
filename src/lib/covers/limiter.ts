import {
  applyMetronHeaders,
  commitMetronSend,
  emptyMetronBudget,
  METRON_FALLBACK_BURST,
  METRON_FALLBACK_DAILY,
  metronSpacingMs,
  pauseLabel,
  planMetronAcquire,
  readMetronRateHeaders,
  type MetronBudget,
  type RateLane,
} from "@/lib/catalog/rate-limit";
import { MetronBudgetError } from "@/lib/covers/types";

export type { MetronBudget, RateLane };
export const METRON_BURST_LIMIT = METRON_FALLBACK_BURST;
export const METRON_DAILY_LIMIT = METRON_FALLBACK_DAILY;
export const METRON_MIN_INTERVAL_MS = 60_000 / METRON_BURST_LIMIT;

export type BudgetStore = {
  read: () => MetronBudget;
  write: (budget: MetronBudget) => void;
};

export function emptyBudget(): MetronBudget {
  return emptyMetronBudget();
}

export function budgetDay(date: Date, timeZone = process.env.TZ || "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** First millisecond of the next budget day in the shelf timezone. */
export function nextBudgetDayStart(nowMs: number, timeZone = process.env.TZ || "America/Chicago"): number {
  const day = budgetDay(new Date(nowMs), timeZone);
  let lo = nowMs;
  let hi = nowMs + 36 * 60 * 60 * 1000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (budgetDay(new Date(mid), timeZone) === day) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function formatResumeTime(ms: number, timeZone = process.env.TZ || "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
}

type HeaderBag = {
  get(name: string): string | null;
};

export function retryAfterMs(headers: HeaderBag, now: number): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dated = Date.parse(raw);
  if (Number.isNaN(dated)) return null;
  return Math.max(0, dated - now);
}

/** First 5xx wait. Each later wait doubles until `METRON_5XX_CAP_MS`. */
export const METRON_5XX_BASE_MS = 1_000;
/** Longest 5xx wait. Further 5xx responses are not retried. */
export const METRON_5XX_CAP_MS = 60_000;

export type MetronStatusPlan =
  | { action: "ok" }
  | { action: "fail" }
  | { action: "retry"; waitMs: number }
  | { action: "pause"; resumeAt: number };

/**
 * 429 waits for the Reset header or Retry-After, once, then pauses.
 * 5xx backs off from 1s to 60s. Every other 4xx fails with no retry.
 */
export function metronStatusPlan(args: {
  status: number;
  headers: HeaderBag;
  body: string;
  attempt: number;
  now: number;
  lane: RateLane;
}): MetronStatusPlan {
  if (args.status === 304 || (args.status >= 200 && args.status < 300)) return { action: "ok" };
  if (args.status === 429) {
    const reset = readMetronRateHeaders(args.headers, args.now);
    const resets = [reset.burstResetAt, reset.sustainedResetAt].filter((value): value is number => value != null && value > args.now);
    const resetWait = resets.length > 0 ? Math.min(...resets) - args.now : null;
    const retryAfter = retryAfterMs(args.headers, args.now) ?? retryAfterFromMessage(args.body);
    const waitMs = resetWait ?? retryAfter ?? 60_000;
    if (args.lane === "background" || args.attempt >= 2 || waitMs > 120_000) {
      return { action: "pause", resumeAt: args.now + waitMs };
    }
    return { action: "retry", waitMs };
  }
  if (args.status >= 500 && args.status <= 599) {
    if (args.attempt > 7) return { action: "fail" };
    const waitMs = Math.min(METRON_5XX_CAP_MS, METRON_5XX_BASE_MS * 2 ** Math.max(0, args.attempt - 1));
    return { action: "retry", waitMs };
  }
  if (args.status >= 400) return { action: "fail" };
  return { action: "fail" };
}

/** Metron's 429 body says "Expected available in N seconds" when Retry-After is absent. */
export function retryAfterFromMessage(body: string): number | null {
  const match = body.match(/expected available in\s+(\d+(?:\.\d+)?)\s+seconds?/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

export class MetronLimiter {
  private budget: MetronBudget;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: BudgetStore,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly day: () => string,
  ) {
    this.budget = store.read();
  }

  snapshot(): MetronBudget {
    return { ...this.budget };
  }

  async acquire(lane: RateLane = "interactive"): Promise<void> {
    const previous = this.pending;
    let release: () => void = () => undefined;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.acquireTurn(lane);
    } finally {
      release();
    }
  }

  private async acquireTurn(lane: RateLane): Promise<void> {
    this.syncFromStore();
    const plan = planMetronAcquire(this.budget, this.now(), lane, this.day());
    if (plan.kind === "pause") {
      const resumeAt = plan.hold.resumeAt > 0 ? plan.hold.resumeAt : nextBudgetDayStart(this.now());
      const pausedUntil = plan.hold.budget === "Metron reserve" ? plan.state.pausedUntil : resumeAt;
      this.budget = { ...plan.state, pausedUntil };
      this.store.write(this.budget);
      throw new MetronBudgetError(pauseLabel("Metron", resumeAt), {
        budget: plan.hold.budget,
        count: plan.hold.count,
        resumeAt,
      });
    }
    if (plan.waitMs > 0) await this.sleep(plan.waitMs);
    this.budget = commitMetronSend(plan.state, this.now(), this.day());
    this.store.write(this.budget);
  }

  /** Pick up waits and counts written by another limiter that shares this store. */
  private syncFromStore(): void {
    const disk = this.store.read();
    if (!disk.day) return;
    if (disk.day !== this.budget.day) {
      if (disk.day > this.budget.day) this.budget = { ...disk };
      return;
    }
    if (disk.count > this.budget.count) this.budget.count = disk.count;
    if (disk.lastRequestAt != null && (this.budget.lastRequestAt == null || disk.lastRequestAt > this.budget.lastRequestAt)) {
      this.budget.lastRequestAt = disk.lastRequestAt;
    }
  }

  defer(ms: number): void {
    const capped = Math.min(Math.max(0, ms), 120_000);
    const spacing = metronSpacingMs(this.budget.burstLimit);
    const until = this.now() + capped - spacing;
    if (this.budget.lastRequestAt == null || this.budget.lastRequestAt < until) {
      this.budget.lastRequestAt = until;
      this.store.write(this.budget);
    }
  }

  /** Remember a Retry-After pause so the next send, including after a restart, waits it out. */
  notePause(resumeAt: number): void {
    if (this.budget.pausedUntil == null || resumeAt > this.budget.pausedUntil) {
      this.budget.pausedUntil = resumeAt;
      this.store.write(this.budget);
    }
  }

  observe(headers: HeaderBag): void {
    this.budget = applyMetronHeaders(this.budget, headers, this.now());
    this.store.write(this.budget);
  }
}
