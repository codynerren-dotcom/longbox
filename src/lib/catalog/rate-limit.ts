/**
 * One rate-limit plan for Metron, the Grand Comics Database, and Comic Vine.
 * Windows live in the caller's store (the database in the app) so a restart
 * keeps the same counters and resume time.
 *
 * Metron (https://github.com/Metron-Project/metron/blob/master/api/RATELIMIT.md,
 * effective March 2026): burst and sustained limits are per authenticated user.
 * Defaults are 20 requests per minute and 5,000 per day. Donors get a higher
 * sustained limit, so those defaults apply only before the first response.
 * After that, read X-RateLimit-Burst-Limit/Remaining/Reset and
 * X-RateLimit-Sustained-Limit/Remaining/Reset. Reset is a unix timestamp in
 * seconds. Stop while Remaining is still 1 so a blocked home IP is not hammered.
 * Space sends across the burst minute (20 per minute is about one every 3 seconds).
 * A 429 waits out Retry-After.
 *
 * GCD legacy /api/ is anonymous and does not publish its hourly cap. The v2
 * scaffold (https://github.com/GrandComicsDatabase/gcd-django/pull/711) documents
 * 30 requests per hour for anonymous clients and 2,000 per day for token or
 * basic auth. Anonymous stays on the existing sliding hour. Saved basic
 * credentials switch the window to 2,000 per day. Retry-After is waited out in full.
 *
 * Comic Vine (https://comicvine.gamespot.com/api/documentation): 200 requests
 * per resource (issues, volumes, search, and the other endpoint types) per hour.
 * HTTP 420, HTTP 429, and JSON status_code 107 are the limit. Bursts trip a
 * separate velocity block, so sends stay at most one per second.
 */

export type RateLane = "interactive" | "background";

/** Shared Metron window. Header fields stay null until the first response. */
export type MetronBudget = {
  day: string;
  count: number;
  lastRequestAt: number | null;
  burstLimit: number | null;
  burstRemaining: number | null;
  burstResetAt: number | null;
  burstUsed: number;
  burstWindowStart: number | null;
  sustainedLimit: number | null;
  sustainedRemaining: number | null;
  sustainedResetAt: number | null;
  pausedUntil: number | null;
};

export function normalizeMetronBudget(value: unknown): MetronBudget {
  const row = value && typeof value === "object" ? (value as Partial<MetronBudget>) : {};
  const base = emptyMetronBudget();
  const count = typeof row.count === "number" && row.count > 0 ? row.count : 0;
  return {
    ...base,
    day: typeof row.day === "string" ? row.day : "",
    count,
    lastRequestAt: typeof row.lastRequestAt === "number" ? row.lastRequestAt : null,
    burstLimit: positive(row.burstLimit),
    burstRemaining: nonNegative(row.burstRemaining),
    burstResetAt: positive(row.burstResetAt),
    burstUsed: typeof row.burstUsed === "number" && row.burstUsed > 0 ? Math.round(row.burstUsed) : 0,
    burstWindowStart: positive(row.burstWindowStart),
    sustainedLimit: positive(row.sustainedLimit),
    sustainedRemaining: nonNegative(row.sustainedRemaining),
    sustainedResetAt: positive(row.sustainedResetAt),
    pausedUntil: positive(row.pausedUntil),
  };
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function emptyMetronBudget(): MetronBudget {
  return {
    day: "",
    count: 0,
    lastRequestAt: null,
    burstLimit: null,
    burstRemaining: null,
    burstResetAt: null,
    burstUsed: 0,
    burstWindowStart: null,
    sustainedLimit: null,
    sustainedRemaining: null,
    sustainedResetAt: null,
    pausedUntil: null,
  };
}

export type RateHold = {
  resumeAt: number;
  budget: string;
  count: number;
};

export const METRON_FALLBACK_BURST = 20;
export const METRON_FALLBACK_DAILY = 5000;
/** Leave one request unused. Remaining 0 is already a 429. */
export const METRON_SAFETY_REMAINING = 1;
/** Background jobs leave this many burst slots so Match can still search. */
export const METRON_INTERACTIVE_RESERVE = 3;
export const METRON_BURST_WINDOW_MS = 60_000;

export const GCD_ANON_PER_HOUR = 30;
export const GCD_AUTH_PER_DAY = 2000;
export const GCD_MIN_GAP_MS = 2_000;
export const GCD_HOUR_MS = 60 * 60 * 1000;
export const GCD_DAY_MS = 24 * 60 * 60 * 1000;
/** Anonymous hour wait never freezes the shelf longer than this. */
export const GCD_LOCAL_CAP_MS = 10 * 60 * 1000;

export const COMIC_VINE_PER_HOUR = 200;
export const COMIC_VINE_MIN_GAP_MS = 1_000;
export const COMIC_VINE_HOUR_MS = 60 * 60 * 1000;

type HeaderBag = { get(name: string): string | null };

export function formatPauseClock(ms: number, timeZone = process.env.TZ || "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function pauseLabel(source: string, resumeAt: number, timeZone = process.env.TZ || "America/Chicago"): string {
  return `${source} paused until ${formatPauseClock(resumeAt, timeZone)}`;
}

export function metronSpacingMs(burstLimit: number | null): number {
  const limit = burstLimit != null && burstLimit > 0 ? burstLimit : METRON_FALLBACK_BURST;
  return Math.round(METRON_BURST_WINDOW_MS / limit);
}

function numberHeader(headers: HeaderBag, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Header reset values are unix seconds. A millisecond value is left alone. */
export function unixResetMs(value: number | null, now: number): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (value > 1e12) return value;
  if (value > 1e9) return value * 1000;
  return now + value * 1000;
}

export type MetronHeaderWindows = {
  burstLimit: number | null;
  burstRemaining: number | null;
  burstResetAt: number | null;
  sustainedLimit: number | null;
  sustainedRemaining: number | null;
  sustainedResetAt: number | null;
};

export function readMetronRateHeaders(headers: HeaderBag, now: number): MetronHeaderWindows {
  return {
    burstLimit: numberHeader(headers, "x-ratelimit-burst-limit"),
    burstRemaining: numberHeader(headers, "x-ratelimit-burst-remaining"),
    burstResetAt: unixResetMs(numberHeader(headers, "x-ratelimit-burst-reset"), now),
    sustainedLimit: numberHeader(headers, "x-ratelimit-sustained-limit"),
    sustainedRemaining: numberHeader(headers, "x-ratelimit-sustained-remaining"),
    sustainedResetAt: unixResetMs(numberHeader(headers, "x-ratelimit-sustained-reset"), now),
  };
}

function cloneBudget(budget: MetronBudget): MetronBudget {
  return { ...budget };
}

function rollMetron(budget: MetronBudget, now: number, day: string): MetronBudget {
  const next = cloneBudget(budget);
  if (next.day !== day) {
    next.day = day;
    next.count = 0;
  }
  if (next.burstWindowStart == null || now - next.burstWindowStart >= METRON_BURST_WINDOW_MS) {
    next.burstWindowStart = now;
    next.burstUsed = 0;
  }
  if (next.burstResetAt != null && now >= next.burstResetAt) {
    next.burstRemaining = next.burstLimit;
    next.burstResetAt = now + METRON_BURST_WINDOW_MS;
    next.burstUsed = 0;
    next.burstWindowStart = now;
  }
  if (next.sustainedResetAt != null && now >= next.sustainedResetAt) {
    next.sustainedRemaining = next.sustainedLimit;
    next.sustainedResetAt = null;
    next.count = 0;
  }
  if (next.pausedUntil != null && next.pausedUntil <= now) next.pausedUntil = null;
  return next;
}

function burstRemainingOf(budget: MetronBudget): number {
  if (budget.burstRemaining != null) return budget.burstRemaining;
  const limit = budget.burstLimit != null && budget.burstLimit > 0 ? budget.burstLimit : METRON_FALLBACK_BURST;
  return limit - budget.burstUsed;
}

function sustainedRemainingOf(budget: MetronBudget): number {
  if (budget.sustainedRemaining != null) return budget.sustainedRemaining;
  const limit = budget.sustainedLimit != null && budget.sustainedLimit > 0 ? budget.sustainedLimit : METRON_FALLBACK_DAILY;
  return limit - budget.count;
}

function sustainedLimitOf(budget: MetronBudget): number {
  return budget.sustainedLimit != null && budget.sustainedLimit > 0 ? budget.sustainedLimit : METRON_FALLBACK_DAILY;
}

export function planMetronAcquire(
  budget: MetronBudget,
  now: number,
  lane: RateLane,
  day: string,
): { kind: "send"; waitMs: number; state: MetronBudget } | { kind: "pause"; hold: RateHold; state: MetronBudget } {
  const state = rollMetron(budget, now, day);
  if (state.pausedUntil != null && state.pausedUntil > now) {
    return {
      kind: "pause",
      state,
      hold: { resumeAt: state.pausedUntil, budget: "Metron", count: state.count, },
    };
  }
  const sustainedRemaining = sustainedRemainingOf(state);
  if (sustainedRemaining <= METRON_SAFETY_REMAINING) {
    const resumeAt = state.sustainedResetAt != null && state.sustainedResetAt > now ? state.sustainedResetAt : 0;
    if (resumeAt > 0) state.pausedUntil = resumeAt;
    return {
      kind: "pause",
      state,
      hold: { resumeAt, budget: "Metron daily", count: sustainedLimitOf(state) - sustainedRemaining },
    };
  }
  const burstRemaining = burstRemainingOf(state);
  const burstFloor = lane === "background" ? METRON_INTERACTIVE_RESERVE + METRON_SAFETY_REMAINING : METRON_SAFETY_REMAINING;
  if (burstRemaining <= burstFloor) {
    const resumeAt =
      state.burstResetAt != null && state.burstResetAt > now
        ? state.burstResetAt
        : (state.burstWindowStart ?? now) + METRON_BURST_WINDOW_MS;
    const reserve = lane === "background" && burstRemaining > METRON_SAFETY_REMAINING;
    if (!reserve) state.pausedUntil = resumeAt;
    return {
      kind: "pause",
      state,
      hold: {
        resumeAt,
        budget: reserve ? "Metron reserve" : "Metron burst",
        count: (state.burstLimit ?? METRON_FALLBACK_BURST) - burstRemaining,
      },
    };
  }
  const waitMs = state.lastRequestAt == null ? 0 : Math.max(0, metronSpacingMs(state.burstLimit) - (now - state.lastRequestAt));
  return { kind: "send", waitMs, state };
}

export function commitMetronSend(budget: MetronBudget, now: number, day: string): MetronBudget {
  const next = rollMetron(budget, now, day);
  next.count += 1;
  next.burstUsed += 1;
  next.lastRequestAt = now;
  if (next.burstRemaining != null) next.burstRemaining = Math.max(0, next.burstRemaining - 1);
  if (next.sustainedRemaining != null) next.sustainedRemaining = Math.max(0, next.sustainedRemaining - 1);
  next.pausedUntil = null;
  return next;
}

/** Replace local guesses with the headers from this response. Remaining <= 1 pauses until Reset. */
export function applyMetronHeaders(budget: MetronBudget, headers: HeaderBag, now: number): MetronBudget {
  const next = cloneBudget(budget);
  const read = readMetronRateHeaders(headers, now);
  if (read.burstLimit != null) next.burstLimit = read.burstLimit;
  if (read.burstRemaining != null) next.burstRemaining = read.burstRemaining;
  if (read.burstResetAt != null) next.burstResetAt = read.burstResetAt;
  if (read.sustainedLimit != null) next.sustainedLimit = read.sustainedLimit;
  if (read.sustainedRemaining != null) next.sustainedRemaining = read.sustainedRemaining;
  if (read.sustainedResetAt != null) next.sustainedResetAt = read.sustainedResetAt;
  if (read.sustainedRemaining === 0) {
    next.count = next.sustainedLimit ?? METRON_FALLBACK_DAILY;
  }
  const resume = earliestExhaustedReset(read, now);
  if (resume != null) next.pausedUntil = resume;
  return next;
}

function earliestExhaustedReset(read: MetronHeaderWindows, now: number): number | null {
  let resume: number | null = null;
  if (read.sustainedRemaining != null && read.sustainedRemaining <= METRON_SAFETY_REMAINING) {
    resume = read.sustainedResetAt != null && read.sustainedResetAt > now ? read.sustainedResetAt : now + 60_000;
  }
  if (read.burstRemaining != null && read.burstRemaining <= METRON_SAFETY_REMAINING) {
    const burstAt = read.burstResetAt != null && read.burstResetAt > now ? read.burstResetAt : now + METRON_BURST_WINDOW_MS;
    resume = resume == null ? burstAt : Math.max(resume, burstAt);
  }
  return resume;
}

export type GcdRateMode = "anonymous" | "authenticated";

export type GcdRateState = {
  mode: GcdRateMode;
  hits: number[];
  pausedUntil: number | null;
  lastSentAt: number | null;
  strikes: number;
};

export function emptyGcdRate(): GcdRateState {
  return { mode: "anonymous", hits: [], pausedUntil: null, lastSentAt: null, strikes: 0 };
}

export function planGcdAcquire(
  state: GcdRateState,
  now: number,
  mode: GcdRateMode,
): { kind: "send"; waitMs: number; state: GcdRateState } | { kind: "pause"; hold: RateHold; state: GcdRateState } {
  const next: GcdRateState = {
    mode,
    hits: state.hits.filter((time) => now - time < (mode === "authenticated" ? GCD_DAY_MS : GCD_HOUR_MS)),
    pausedUntil: state.pausedUntil != null && state.pausedUntil > now ? state.pausedUntil : null,
    lastSentAt: state.lastSentAt,
    strikes: state.strikes,
  };
  if (next.pausedUntil != null) {
    return {
      kind: "pause",
      state: next,
      hold: { resumeAt: next.pausedUntil, budget: mode === "authenticated" ? "GCD daily" : "GCD hourly", count: next.hits.length },
    };
  }
  const cap = mode === "authenticated" ? GCD_AUTH_PER_DAY : GCD_ANON_PER_HOUR;
  if (next.hits.length >= cap) {
    const oldest = next.hits[0] ?? now;
    const windowMs = mode === "authenticated" ? GCD_DAY_MS : GCD_HOUR_MS;
    const raw = oldest + windowMs;
    const resumeAt = mode === "anonymous" ? Math.min(raw, now + GCD_LOCAL_CAP_MS) : raw;
    next.pausedUntil = resumeAt;
    return {
      kind: "pause",
      state: next,
      hold: { resumeAt, budget: mode === "authenticated" ? "GCD daily" : "GCD hourly", count: next.hits.length },
    };
  }
  const waitMs = next.lastSentAt == null ? 0 : Math.max(0, GCD_MIN_GAP_MS - (now - next.lastSentAt));
  next.hits.push(now + waitMs);
  next.lastSentAt = now + waitMs;
  return { kind: "send", waitMs, state: next };
}

export function noteGcdRetry(state: GcdRateState, delayMs: number, now: number): GcdRateState {
  return { ...state, pausedUntil: now + delayMs, strikes: delayMs > 0 ? state.strikes : state.strikes };
}

export type ComicVineRateState = {
  lastSentAt: number | null;
  pausedUntil: number | null;
  resources: Record<string, number[]>;
};

export function emptyComicVineRate(): ComicVineRateState {
  return { lastSentAt: null, pausedUntil: null, resources: {} };
}

/** issues and issue share one hourly bucket. volumes and volume do too. */
export function comicVineResource(path: string): string {
  const match = path.match(/\/(search|issues|issue|volumes|volume|characters|publishers|story_arcs|movies|powers|origins|objects|locations|concepts|teams|people|promos)(?:\/|$)/i);
  const raw = (match?.[1] ?? "other").toLowerCase();
  if (raw === "issue" || raw === "issues") return "issues";
  if (raw === "volume" || raw === "volumes") return "volumes";
  return raw;
}

export function planComicVineAcquire(
  state: ComicVineRateState,
  now: number,
  resource: string,
): { kind: "send"; waitMs: number; state: ComicVineRateState } | { kind: "pause"; hold: RateHold; state: ComicVineRateState } {
  const resources: Record<string, number[]> = {};
  for (const [key, times] of Object.entries(state.resources)) {
    const fresh = times.filter((time) => now - time < COMIC_VINE_HOUR_MS);
    if (fresh.length > 0) resources[key] = fresh;
  }
  const next: ComicVineRateState = {
    lastSentAt: state.lastSentAt,
    pausedUntil: state.pausedUntil != null && state.pausedUntil > now ? state.pausedUntil : null,
    resources,
  };
  if (next.pausedUntil != null) {
    return {
      kind: "pause",
      state: next,
      hold: { resumeAt: next.pausedUntil, budget: "Comic Vine", count: next.resources[resource]?.length ?? 0 },
    };
  }
  const hits = next.resources[resource] ?? [];
  if (hits.length >= COMIC_VINE_PER_HOUR) {
    const oldest = hits[0] ?? now;
    const resumeAt = oldest + COMIC_VINE_HOUR_MS;
    next.pausedUntil = resumeAt;
    return {
      kind: "pause",
      state: next,
      hold: { resumeAt, budget: `Comic Vine ${resource}`, count: hits.length },
    };
  }
  const waitMs = next.lastSentAt == null ? 0 : Math.max(0, COMIC_VINE_MIN_GAP_MS - (now - next.lastSentAt));
  const sentAt = now + waitMs;
  next.resources[resource] = [...hits, sentAt];
  next.lastSentAt = sentAt;
  return { kind: "send", waitMs, state: next };
}

export function noteComicVinePause(state: ComicVineRateState, resumeAt: number): ComicVineRateState {
  return { ...state, pausedUntil: resumeAt };
}

/**
 * Gap for hosts whose published docs do not cover this particular request.
 * Cover files are not the Metron API (RATELIMIT.md) and not a Comic Vine resource,
 * so they keep their own persisted gap. eBay's token route is the same idea:
 * the Analytics getRateLimits method is how an app reads its own Browse caps
 * (https://developer.ebay.com/api-docs/developer/analytics/resources/rate_limit/methods/getRateLimits),
 * and this shelf does not call that yet. Both still wait out Retry-After.
 *
 * Image hosts are separate from those API budgets:
 * - files1.comics.org returns 403 for automated cover fetches. GCD's 30/hour and
 *   2,000/day limits are for `/api/` (https://github.com/GrandComicsDatabase/gcd-django/wiki/API).
 *   Staff asked tools not to bulk-download scans, because Cloudflare will block that
 *   (https://github.com/GrandComicsDatabase/gcd-django/discussions/614). This shelf does
 *   not hotlink or download those scans. A GCD accept looks up the same issue on Metron
 *   or Comic Vine instead.
 * - comicvine.gamespot.com image files are not an API resource. The published cap is
 *   200 requests per resource per hour, plus velocity detection
 *   (https://comicvine.gamespot.com/api/). Image downloads use `pace:comicvine-images`
 *   at the same one-per-second gap and do not spend that API budget.
 */
export const COVER_MIN_GAP_MS = 1_000;
export const EBAY_MIN_GAP_MS = 2_000;
export const GCD_IMAGE_HOST = "files1.comics.org";
export const COMICVINE_IMAGE_HOST = "comicvine.gamespot.com";

export type ImagePaceName = "gcd-images" | "comicvine-images" | "covers";

export function imagePaceName(hostname: string): ImagePaceName {
  const host = hostname.toLowerCase();
  if (host === GCD_IMAGE_HOST) return "gcd-images";
  if (host === COMICVINE_IMAGE_HOST) return "comicvine-images";
  return "covers";
}

export type PaceWindow = {
  lastSentAt: number | null;
  pausedUntil: number | null;
};

export function emptyPace(): PaceWindow {
  return { lastSentAt: null, pausedUntil: null };
}

export function normalizePace(value: unknown): PaceWindow {
  const row = value && typeof value === "object" ? (value as Partial<PaceWindow>) : {};
  return {
    lastSentAt: typeof row.lastSentAt === "number" && row.lastSentAt > 0 ? row.lastSentAt : null,
    pausedUntil: typeof row.pausedUntil === "number" && row.pausedUntil > 0 ? row.pausedUntil : null,
  };
}

export function planPaceAcquire(
  state: PaceWindow,
  now: number,
  minGapMs: number,
): { kind: "send"; waitMs: number; state: PaceWindow } | { kind: "pause"; hold: RateHold; state: PaceWindow } {
  const pausedUntil = state.pausedUntil != null && state.pausedUntil > now ? state.pausedUntil : null;
  const next: PaceWindow = { lastSentAt: state.lastSentAt, pausedUntil };
  if (pausedUntil != null) {
    return { kind: "pause", state: next, hold: { resumeAt: pausedUntil, budget: "pace", count: 0 } };
  }
  const waitMs = next.lastSentAt == null ? 0 : Math.max(0, minGapMs - (now - next.lastSentAt));
  next.lastSentAt = now + waitMs;
  return { kind: "send", waitMs, state: next };
}

export function notePacePause(state: PaceWindow, resumeAt: number): PaceWindow {
  return { ...state, pausedUntil: resumeAt };
}

export type JobName = "backfill" | "enrich";

export type JobCursor = {
  job: JobName;
  cursorId: string | null;
  resumeAt: number | null;
  reason: string | null;
};

export function sliceAfterCursor<T extends { id: string }>(rows: T[], cursorId: string | null): T[] {
  if (!cursorId) return rows;
  const index = rows.findIndex((row) => row.id === cursorId);
  if (index < 0) return rows;
  return rows.slice(index + 1);
}

export type UsageWindow = {
  source: string;
  label: string;
  used: number;
  limit: number;
  resetAt: number | null;
  pausedUntil: number | null;
  /** Saved GCD basic auth. The day window is 2,000 requests. */
  signedIn?: boolean;
};

export function metronUsage(budget: MetronBudget, now: number): UsageWindow[] {
  const burstLimit = budget.burstLimit != null && budget.burstLimit > 0 ? budget.burstLimit : METRON_FALLBACK_BURST;
  const burstRemaining = burstRemainingOf(rollMetron(budget, now, budget.day || ""));
  const dailyLimit = sustainedLimitOf(budget);
  const dailyRemaining = sustainedRemainingOf(rollMetron(budget, now, budget.day || ""));
  const paused = budget.pausedUntil != null && budget.pausedUntil > now ? budget.pausedUntil : null;
  return [
    {
      source: "Metron",
      label: "Burst",
      used: Math.max(0, burstLimit - burstRemaining),
      limit: burstLimit,
      resetAt: budget.burstResetAt,
      pausedUntil: paused,
    },
    {
      source: "Metron",
      label: "Sustained",
      used: Math.max(0, dailyLimit - dailyRemaining),
      limit: dailyLimit,
      resetAt: budget.sustainedResetAt,
      pausedUntil: paused,
    },
  ];
}

export function gcdUsage(state: GcdRateState, now: number, signedIn = state.mode === "authenticated"): UsageWindow {
  const windowMs = signedIn ? GCD_DAY_MS : GCD_HOUR_MS;
  const fresh = state.hits.filter((time) => now - time < windowMs);
  const oldest = fresh[0] ?? null;
  return {
    source: "GCD",
    label: signedIn ? "Day" : "Hour",
    used: fresh.length,
    limit: signedIn ? GCD_AUTH_PER_DAY : GCD_ANON_PER_HOUR,
    resetAt: oldest == null ? null : oldest + windowMs,
    pausedUntil: state.pausedUntil != null && state.pausedUntil > now ? state.pausedUntil : null,
    signedIn,
  };
}

export function comicVineUsage(state: ComicVineRateState, now: number): UsageWindow[] {
  const paused = state.pausedUntil != null && state.pausedUntil > now ? state.pausedUntil : null;
  const rows = Object.entries(state.resources)
    .map(([resource, times]) => {
      const fresh = times.filter((time) => now - time < COMIC_VINE_HOUR_MS);
      const oldest = fresh[0] ?? null;
      return {
        source: "Comic Vine",
        label: resource,
        used: fresh.length,
        limit: COMIC_VINE_PER_HOUR,
        resetAt: oldest == null ? null : oldest + COMIC_VINE_HOUR_MS,
        pausedUntil: paused,
      };
    })
    .filter((row) => row.used > 0 || row.pausedUntil != null);
  if (rows.length > 0) return rows;
  return [
    {
      source: "Comic Vine",
      label: "Hour",
      used: 0,
      limit: COMIC_VINE_PER_HOUR,
      resetAt: null,
      pausedUntil: paused,
    },
  ];
}
