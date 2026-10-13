import { MetronBudgetError } from "@/lib/covers/types";

export const METRON_BURST_LIMIT = 20;
export const METRON_DAILY_LIMIT = 5000;
export const METRON_MIN_INTERVAL_MS = 60_000 / METRON_BURST_LIMIT;

export type MetronBudget = {
  day: string;
  count: number;
  lastRequestAt: number | null;
};

export type BudgetStore = {
  read: () => MetronBudget;
  write: (budget: MetronBudget) => void;
};

export function emptyBudget(): MetronBudget {
  return { day: "", count: 0, lastRequestAt: null };
}

export function budgetDay(date: Date, timeZone = process.env.TZ || "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
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

export class MetronLimiter {
  private budget: MetronBudget;

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

  async acquire(): Promise<void> {
    const day = this.day();
    if (this.budget.day !== day) {
      this.budget.day = day;
      this.budget.count = 0;
    }
    if (this.budget.count >= METRON_DAILY_LIMIT) {
      throw new MetronBudgetError("Metron daily limit reached (5000). Run again after the window resets.");
    }
    const wait = this.msUntilNext();
    if (wait > 0) await this.sleep(wait);
    this.budget.count += 1;
    this.budget.lastRequestAt = this.now();
    this.store.write(this.budget);
  }

  defer(ms: number): void {
    const capped = Math.min(Math.max(0, ms), 120_000);
    const until = this.now() + capped - METRON_MIN_INTERVAL_MS;
    if (this.budget.lastRequestAt == null || this.budget.lastRequestAt < until) {
      this.budget.lastRequestAt = until;
      this.store.write(this.budget);
    }
  }

  observe(headers: HeaderBag): void {
    const sustainedRemaining = numberHeader(headers, "x-ratelimit-sustained-remaining");
    const sustainedLimit = numberHeader(headers, "x-ratelimit-sustained-limit");
    if (sustainedRemaining === 0) {
      this.budget.count = METRON_DAILY_LIMIT;
      this.store.write(this.budget);
    } else if (sustainedRemaining != null && sustainedLimit != null) {
      const used = Math.max(0, sustainedLimit - sustainedRemaining);
      if (used > this.budget.count) {
        this.budget.count = Math.min(used, METRON_DAILY_LIMIT);
        this.store.write(this.budget);
      }
    }

    const burstRemaining = numberHeader(headers, "x-ratelimit-burst-remaining");
    const burstReset = numberHeader(headers, "x-ratelimit-burst-reset");
    if (burstRemaining === 0 && burstReset != null) {
      const delay = burstReset * 1000 - this.now();
      if (delay > 0) this.defer(Math.min(delay, 65_000));
    }
  }

  private msUntilNext(): number {
    if (this.budget.lastRequestAt == null) return 0;
    return Math.max(0, METRON_MIN_INTERVAL_MS - (this.now() - this.budget.lastRequestAt));
  }
}

function numberHeader(headers: HeaderBag, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
