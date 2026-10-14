import type { BackfillStatus } from "@/lib/covers/files";

export const BACKFILL_POLL_MS = 5000;

const PAGES = new Set(["/settings", "/covers"]);

/** Settings and Covers poll while open. Elsewhere, only a running backfill keeps the sidebar chip current. Nothing here changes the URL. */
export function backfillPollPlan(pathname: string, running: boolean): { poll: boolean; navigate: false } {
  const onPage = PAGES.has(pathname);
  return { poll: onPage || running, navigate: false };
}

export function backfillProgressLabel(
  status: Pick<BackfillStatus, "running" | "matched" | "unmatched"> & { task?: string | null; skipped?: number } | null,
): string | null {
  if (!status?.running) return null;
  if (status.task === "enrich") return `Metron details · ${status.matched} filled · ${status.skipped ?? 0} unchanged`;
  return `Covers running · ${status.matched} matched · ${status.unmatched} unmatched`;
}

export function normalizeBackfillStatus(value: unknown): BackfillStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    running: row.running === true,
    startedAt: text(row.startedAt),
    finishedAt: text(row.finishedAt),
    matched: count(row.matched),
    unmatched: count(row.unmatched),
    skipped: count(row.skipped),
    pending: count(row.pending),
    stoppedReason: text(row.stoppedReason),
    message: text(row.message),
    task: row.task === "enrich" ? "enrich" : "covers",
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
