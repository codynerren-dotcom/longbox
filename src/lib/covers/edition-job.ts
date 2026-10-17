import { formatResumeTime } from "@/lib/covers/limiter";

/** A running re-match with no heartbeat newer than this is stale. */
export const EDITION_STALE_MS = 10 * 60 * 1000;

export const EDITION_STALE_MESSAGE = "Edition re-match had no progress for 10 minutes.";

export type EditionJobPhase = "running" | "paused" | "finished" | "error" | "stale";

export type EditionMisses = Record<string, number>;

export type EditionJobState = {
  state: EditionJobPhase;
  message: string | null;
  resumeAt: string | null;
  metronResumeAt: string | null;
  matched: number;
  unmatched: number;
  updatedAt: string;
  attempted: number;
  proposed: number;
  noCandidate: number;
  skipped: number;
  cursorId: string | null;
  heartbeatAt: string | null;
  runId: string | null;
  mode: "propose" | "apply" | null;
  scope: "suspect" | "full";
  misses: EditionMisses;
};

export function editionJobText(job: EditionJobState | null): string | null {
  if (!job) return null;
  if (job.state === "running") return "Edition re-match: running";
  if (job.state === "finished") return "Edition re-match: finished";
  if (job.state === "error") return job.message ? `Edition re-match: error. ${job.message}` : "Edition re-match: error";
  if (job.state === "stale") return "Edition re-match: stale";
  if (job.resumeAt) {
    const at = Date.parse(job.resumeAt);
    const when = Number.isFinite(at) ? formatResumeTime(at) : job.resumeAt;
    return `Edition re-match: paused until ${when}`;
  }
  return "Edition re-match: paused";
}

/** Attempted, proposed, no-candidate, and miss counts for Logs and Review. */
export function editionSummaryText(job: EditionJobState | null): string | null {
  if (!job) return null;
  const misses = Object.entries(job.misses)
    .filter((entry) => entry[1] > 0)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  if (job.attempted === 0 && job.proposed === 0 && job.noCandidate === 0 && !misses) return null;
  const base = `Attempted ${job.attempted}. Proposed ${job.proposed}. No candidate ${job.noCandidate}.`;
  return misses ? `${base} Misses: ${misses}.` : base;
}

export function editionProgressAt(job: EditionJobState): number {
  const heartbeat = job.heartbeatAt ? Date.parse(job.heartbeatAt) : Number.NaN;
  if (Number.isFinite(heartbeat)) return heartbeat;
  const updated = Date.parse(job.updatedAt);
  return Number.isFinite(updated) ? updated : 0;
}

/** True when a running job has had no progress for more than 10 minutes. */
export function editionRunStale(job: EditionJobState | null, now = Date.now()): boolean {
  if (!job || job.state !== "running") return false;
  return now - editionProgressAt(job) > EDITION_STALE_MS;
}

/** A fresh running pass blocks another start. A stale running pass does not. */
export function editionRunBlocks(job: EditionJobState | null, now = Date.now()): boolean {
  if (!job || job.state !== "running") return false;
  return !editionRunStale(job, now);
}

export function missCategory(reason: string): string {
  const text = reason.toLowerCase();
  if (text.includes("not on metron") || text.includes("no collected-edition series")) return "not-on-metron";
  if (text.includes("several")) return "several";
  if (text.includes("budget") || text.includes("paused") || text.includes("resumes at")) return "budget";
  if (text.includes("no confident") || text.includes("not confident")) return "low-confidence";
  if (text.includes("no ") && (text.includes("series") || text.includes("collected"))) return "no-series";
  if (text.startsWith("no ") || text.includes(" no ")) return "no-issue";
  return "other";
}

export function addMiss(misses: EditionMisses, reason: string): EditionMisses {
  const key = missCategory(reason);
  return { ...misses, [key]: (misses[key] ?? 0) + 1 };
}

/** Comics after the last one this run finished. An unknown cursor starts over. */
export function comicsAfterCursor<T extends { id: string }>(rows: T[], cursorId: string | null | undefined): T[] {
  if (!cursorId) return rows;
  const index = rows.findIndex((row) => row.id === cursorId);
  if (index < 0) return rows;
  return rows.slice(index + 1);
}

/** A pause continues the same run. A new pass, or a resume with no stored id, gets a fresh one. */
export function continuedRunId(resume: boolean, previous: string | null | undefined, next: () => string): string {
  if (resume && previous) return previous;
  return next();
}

export type ResumeWake = { kind: "resume" } | { kind: "again"; at: number } | { kind: "stale" } | { kind: "error"; message: string };

/**
 * A due pause resumes when the pass is idle.
 * While the pass is still in flight the timer waits, then goes stale instead of postponing forever.
 */
export function nextResumeWake(input: { inflight: boolean; resumeAt: number; now: number; postponedFrom: number | null }): ResumeWake {
  if (!Number.isFinite(input.resumeAt)) return { kind: "error", message: "Edition re-match pause had no resume time." };
  if (!input.inflight) {
    if (input.resumeAt > input.now) return { kind: "again", at: input.resumeAt };
    return { kind: "resume" };
  }
  const since = input.postponedFrom ?? input.resumeAt;
  if (input.now - since >= EDITION_STALE_MS) return { kind: "stale" };
  return { kind: "again", at: input.now + 1_000 };
}

/** Arm a pause. A scheduler that throws is a loud failure, not a silent stall. */
export function armEditionPause(input: {
  now: number;
  resumeAt: number;
  schedule: (ms: number, fn: () => void) => void;
  onResume: () => void;
}): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(input.resumeAt)) return { ok: false, message: "Edition re-match pause had no resume time." };
  try {
    input.schedule(Math.max(0, input.resumeAt - input.now), input.onResume);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Edition re-match could not arm the resume timer.";
    return { ok: false, message };
  }
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function missesOf(value: unknown): EditionMisses {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const misses: EditionMisses = {};
  for (const [key, count] of Object.entries(value)) {
    if (!key || typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
    misses[key] = Math.round(count);
  }
  return misses;
}

export function isEditionPhase(value: unknown): value is EditionJobPhase {
  return value === "running" || value === "paused" || value === "finished" || value === "error" || value === "stale";
}

export function editionJobFromUnknown(value: unknown): EditionJobState | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<EditionJobState>;
  if (!isEditionPhase(parsed.state)) return null;
  const matched = whole(parsed.matched);
  const unmatched = whole(parsed.unmatched);
  return {
    state: parsed.state,
    message: typeof parsed.message === "string" ? parsed.message : null,
    resumeAt: typeof parsed.resumeAt === "string" ? parsed.resumeAt : null,
    metronResumeAt: typeof parsed.metronResumeAt === "string" ? parsed.metronResumeAt : null,
    matched,
    unmatched,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    attempted: typeof parsed.attempted === "number" ? whole(parsed.attempted) : 0,
    proposed: typeof parsed.proposed === "number" ? whole(parsed.proposed) : matched,
    noCandidate: typeof parsed.noCandidate === "number" ? whole(parsed.noCandidate) : unmatched,
    skipped: whole(parsed.skipped),
    cursorId: typeof parsed.cursorId === "string" && parsed.cursorId ? parsed.cursorId : null,
    heartbeatAt: typeof parsed.heartbeatAt === "string" ? parsed.heartbeatAt : null,
    runId: typeof parsed.runId === "string" && parsed.runId ? parsed.runId : null,
    mode: parsed.mode === "propose" || parsed.mode === "apply" ? parsed.mode : null,
    scope: parsed.scope === "full" ? "full" : "suspect",
    misses: missesOf(parsed.misses),
  };
}
