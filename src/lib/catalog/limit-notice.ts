import {
  COMIC_VINE_PER_HOUR,
  formatPauseClock,
  GCD_ANON_PER_HOUR,
  GCD_AUTH_PER_DAY,
  METRON_FALLBACK_BURST,
  METRON_FALLBACK_DAILY,
  METRON_SAFETY_REMAINING,
} from "@/lib/catalog/rate-limit";

export type LimitSource = "Metron" | "GCD" | "Comic Vine";

export type LimitBlock = {
  source: LimitSource;
  kind: "limit" | "unreachable";
  limit: string | null;
  resumeAt: number;
};

/** Comic Vine's hourly cap. The message stays the pause label; the notice is built from `pause`. */
export class ComicVineBudgetError extends Error {
  readonly pause: { budget: string; count: number | null; resumeAt: number };

  constructor(message: string, pause?: { budget?: string; count?: number | null; resumeAt?: number }) {
    super(message);
    this.name = "ComicVineBudgetError";
    this.pause = {
      budget: pause?.budget ?? "Comic Vine",
      count: pause?.count ?? null,
      resumeAt: pause?.resumeAt ?? 0,
    };
  }
}

type MetronLimitState = {
  burstLimit?: number | null;
  sustainedLimit?: number | null;
  sustainedRemaining?: number | null;
  burstRemaining?: number | null;
  sustainedResetAt?: number | null;
  burstResetAt?: number | null;
  pausedUntil?: number | null;
};

export function formatLimitCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function metronLimitLabel(budget: string, state?: MetronLimitState | null): string {
  const burst = state?.burstLimit != null && state.burstLimit > 0 ? state.burstLimit : METRON_FALLBACK_BURST;
  const daily = state?.sustainedLimit != null && state.sustainedLimit > 0 ? state.sustainedLimit : METRON_FALLBACK_DAILY;
  if (budget === "Metron burst" || budget === "Metron reserve") return `${formatLimitCount(burst)}/min`;
  if (budget === "Metron daily") return `${formatLimitCount(daily)}/day`;
  const until = state?.pausedUntil ?? null;
  const dailyReset = state?.sustainedResetAt ?? null;
  const burstReset = state?.burstResetAt ?? null;
  const dailyWindow =
    (until != null && dailyReset != null && until === dailyReset && (burstReset == null || dailyReset >= burstReset)) ||
    (state?.sustainedRemaining != null &&
      state.sustainedRemaining <= METRON_SAFETY_REMAINING &&
      (state.burstRemaining == null || state.burstRemaining > METRON_SAFETY_REMAINING));
  if (dailyWindow) return `${formatLimitCount(daily)}/day`;
  return `${formatLimitCount(burst)}/min`;
}

export function gcdLimitLabel(budget: string): string {
  if (/daily|day/i.test(budget)) return `${formatLimitCount(GCD_AUTH_PER_DAY)}/day`;
  return `${formatLimitCount(GCD_ANON_PER_HOUR)}/hour`;
}

export function comicVineLimitLabel(): string {
  return `${formatLimitCount(COMIC_VINE_PER_HOUR)}/hour`;
}

function joinSearched(names: string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return "";
  if (unique.length === 1) return `${unique[0]} was searched.`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} were searched.`;
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]} were searched.`;
}

export function limitNotice(block: LimitBlock, searched: string[] = [], timeZone = process.env.TZ || "America/Chicago"): string {
  const clock = formatPauseClock(block.resumeAt, timeZone);
  const head =
    block.kind === "unreachable"
      ? `${block.source} unreachable, retrying at ${clock}.`
      : `${block.source} limit reached (${block.limit}). Resets at ${clock}.`;
  const rest = joinSearched(searched);
  return rest ? `${head} ${rest}` : head;
}

export function limitNotices(blocks: LimitBlock[], searched: string[] = [], timeZone = process.env.TZ || "America/Chicago"): string {
  const unique: LimitBlock[] = [];
  for (const block of blocks) {
    if (!(block.resumeAt > 0)) continue;
    if (unique.some((item) => item.source === block.source && item.kind === block.kind)) continue;
    unique.push(block);
  }
  if (unique.length === 0) return "";
  const blocked = new Set(unique.map((block) => block.source));
  const stillSearched = searched.filter((name) => !blocked.has(name as LimitSource));
  return unique
    .map((block, index) => limitNotice(block, index === unique.length - 1 ? stillSearched : [], timeZone))
    .join(" ");
}

function readPause(error: unknown): { name: string; budget: string; resumeAt: number } | null {
  if (!error || typeof error !== "object") return null;
  const row = error as { name?: unknown; pause?: { budget?: unknown; resumeAt?: unknown } };
  if (row.name !== "MetronBudgetError" && row.name !== "GcdBudgetError" && row.name !== "ComicVineBudgetError") return null;
  if (typeof row.pause?.resumeAt !== "number" || !(row.pause.resumeAt > 0)) return null;
  return { name: row.name, budget: typeof row.pause.budget === "string" ? row.pause.budget : "", resumeAt: row.pause.resumeAt };
}

export function limitBlockFromError(error: unknown, metron?: MetronLimitState | null): LimitBlock | null {
  const pause = readPause(error);
  if (!pause || pause.budget === "Metron job") return null;
  if (pause.name === "MetronBudgetError" && pause.budget === "Metron connect") {
    return { source: "Metron", kind: "unreachable", limit: null, resumeAt: pause.resumeAt };
  }
  if (pause.name === "MetronBudgetError") {
    return { source: "Metron", kind: "limit", limit: metronLimitLabel(pause.budget, metron), resumeAt: pause.resumeAt };
  }
  if (pause.name === "GcdBudgetError") {
    return { source: "GCD", kind: "limit", limit: gcdLimitLabel(pause.budget), resumeAt: pause.resumeAt };
  }
  return { source: "Comic Vine", kind: "limit", limit: comicVineLimitLabel(), resumeAt: pause.resumeAt };
}

export function blocksFromWindows(input: {
  now: number;
  metronPausedUntil: number | null;
  metronBudget: string;
  metron?: MetronLimitState | null;
  circuitOpenUntil: number;
  gcdPausedUntil: number | null;
  gcdBudget: string;
  comicVinePausedUntil: number | null;
}): LimitBlock[] {
  const blocks: LimitBlock[] = [];
  if (input.circuitOpenUntil > input.now) {
    blocks.push({ source: "Metron", kind: "unreachable", limit: null, resumeAt: input.circuitOpenUntil });
  } else if (input.metronPausedUntil != null && input.metronPausedUntil > input.now) {
    blocks.push({
      source: "Metron",
      kind: "limit",
      limit: metronLimitLabel(input.metronBudget, { ...input.metron, pausedUntil: input.metronPausedUntil }),
      resumeAt: input.metronPausedUntil,
    });
  }
  if (input.gcdPausedUntil != null && input.gcdPausedUntil > input.now) {
    blocks.push({ source: "GCD", kind: "limit", limit: gcdLimitLabel(input.gcdBudget), resumeAt: input.gcdPausedUntil });
  }
  if (input.comicVinePausedUntil != null && input.comicVinePausedUntil > input.now) {
    blocks.push({
      source: "Comic Vine",
      kind: "limit",
      limit: comicVineLimitLabel(),
      resumeAt: input.comicVinePausedUntil,
    });
  }
  return blocks;
}

/** The Match sheet uses this instead of "No matches." when a catalog is paused. */
export function matchPanelNote(hitCount: number, notice: string | null, emptyNote = "No matches."): string {
  if (notice) return notice;
  if (hitCount === 0) return emptyNote;
  return "";
}
