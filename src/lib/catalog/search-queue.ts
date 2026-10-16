import { formatPauseClock } from "@/lib/catalog/rate-limit";
import type { MatchHit } from "@/lib/catalog/match-hits";

export type QueueSource = "metron" | "gcd" | "comicvine";
export type QueueKind = "search" | "relink";

export type QueueHint = {
  source: QueueSource;
  resumeAt: number;
  kind: QueueKind;
};

export type QueuePayload = {
  query?: string;
  barcode?: string;
  mode?: "query" | "barcode";
  shelfFormat?: string | null;
  facsimile?: boolean;
  shelfSeries?: string | null;
  gcdRef?: string | null;
  hit?: unknown;
  useCover?: boolean;
  fillMissing?: boolean;
  overwrite?: boolean;
  replaceExisting?: boolean;
  coverImageUrl?: string | null;
};

export type QueueRecord = {
  id: string;
  comicId: string;
  source: QueueSource;
  kind: QueueKind;
  label: string;
  resumeAt: number;
  createdAt: number;
  payload: QueuePayload;
};

export type QueueInput = {
  id?: string;
  comicId: string;
  source: QueueSource;
  kind: QueueKind;
  label: string;
  resumeAt: number;
  createdAt?: number;
  payload?: QueuePayload;
};

/** What the browser sends when Cody chooses Queue it. The label is loaded from the shelf. */
export type QueueRequest = {
  comicId: string;
  source: QueueSource;
  kind: QueueKind;
  resumeAt: number;
  query?: string;
  barcode?: string;
  mode?: "query" | "barcode";
  shelfFormat?: string | null;
  facsimile?: boolean;
  shelfSeries?: string | null;
  gcdRef?: string | null;
  hit?: unknown;
  useCover?: boolean;
  fillMissing?: boolean;
  overwrite?: boolean;
  replaceExisting?: boolean;
  coverImageUrl?: string | null;
};

export type QueueSeed = {
  comicId: string;
  source: QueueSource;
  resumeAt: number;
  kind: QueueKind;
};

const SOURCE_NAMES: Record<string, QueueSource> = {
  metron: "metron",
  gcd: "gcd",
  comicvine: "comicvine",
  Metron: "metron",
  GCD: "gcd",
  "Comic Vine": "comicvine",
};

export function isQueueSource(value: string): value is QueueSource {
  return value === "metron" || value === "gcd" || value === "comicvine";
}

export function isQueueKind(value: string): value is QueueKind {
  return value === "search" || value === "relink";
}

export function queueSourceOf(label: string): QueueSource | null {
  return SOURCE_NAMES[label] ?? null;
}

export function queueSourceLabel(source: string): string {
  const key = queueSourceOf(source);
  if (key === "metron") return "Metron";
  if (key === "gcd") return "GCD";
  if (key === "comicvine") return "Comic Vine";
  return source;
}

/** Prefer the source Cody asked for. Otherwise take the first block that can be queued. */
export function hintFromBlocks(
  requested: string,
  blocks: { source: string; resumeAt: number }[],
  kind: QueueKind,
): QueueHint | null {
  const mapped = blocks.flatMap((block) => {
    const source = queueSourceOf(block.source);
    if (!source || !(block.resumeAt > 0)) return [];
    return [{ source, resumeAt: block.resumeAt }];
  });
  if (mapped.length === 0) return null;
  const wanted = queueSourceOf(requested);
  const hit = (wanted && mapped.find((block) => block.source === wanted)) || mapped[0];
  return { source: hit.source, resumeAt: hit.resumeAt, kind };
}

export function enqueueInto(
  rows: QueueRecord[],
  input: QueueInput,
  now = Date.now(),
): { rows: QueueRecord[]; status: "added" | "duplicate"; row: QueueRecord } {
  const existing = rows.find((row) => row.comicId === input.comicId && row.source === input.source);
  if (existing) return { rows, status: "duplicate", row: existing };
  const row: QueueRecord = {
    id: input.id ?? `q${rows.length + 1}`,
    comicId: input.comicId,
    source: input.source,
    kind: input.kind,
    label: input.label,
    resumeAt: input.resumeAt,
    createdAt: input.createdAt ?? now,
    payload: input.payload ?? {},
  };
  return { rows: [...rows, row], status: "added", row };
}

export function cancelQueueItem(rows: QueueRecord[], id: string): { rows: QueueRecord[]; removed: QueueRecord | null } {
  const removed = rows.find((row) => row.id === id) ?? null;
  if (!removed) return { rows, removed: null };
  return { rows: rows.filter((row) => row.id !== id), removed };
}

/** Due rows first by resume time, then by the order they were queued. */
export function dueQueue(rows: QueueRecord[], now: number): QueueRecord[] {
  return rows.filter((row) => row.resumeAt <= now).sort((a, b) => a.resumeAt - b.resumeAt || a.createdAt - b.createdAt);
}

export type RunSlot = { at: number; lane: "queue" | "background" };

/** A queued search at the same timestamp runs before a background job. */
export function runOrder(slots: RunSlot[]): RunSlot[] {
  const rank = { queue: 0, background: 1 } as const;
  return [...slots].sort((a, b) => a.at - b.at || rank[a.lane] - rank[b.lane]);
}

export function holdForWindow(row: QueueRecord, resumeAt: number): QueueRecord {
  return { ...row, resumeAt };
}

export type AttemptOutcome = { status: "paused"; resumeAt: number } | { status: "matched" } | { status: "empty" };

export function applyAttempt(
  rows: QueueRecord[],
  id: string,
  outcome: AttemptOutcome,
): { rows: QueueRecord[]; notice: string | null; row: QueueRecord | null } {
  const row = rows.find((item) => item.id === id) ?? null;
  if (!row) return { rows, notice: null, row: null };
  if (outcome.status === "paused") {
    const next = holdForWindow(row, outcome.resumeAt);
    return { rows: rows.map((item) => (item.id === id ? next : item)), notice: null, row: next };
  }
  return { rows: rows.filter((item) => item.id !== id), notice: queueResultMessage(row, outcome.status), row };
}

export function queueResultMessage(row: { label: string; source: string }, status: "matched" | "proposed" | "empty"): string {
  const name = queueSourceLabel(row.source);
  if (status === "matched") return `Matched ${row.label} on ${name}.`;
  if (status === "proposed") return `Proposed a match for ${row.label} on ${name}. Review it before linking.`;
  return `No matches for ${row.label} on ${name}.`;
}

export function queueResultHref(comicId: string): string {
  return `/issues/${comicId}`;
}

export function queuedLogHref(details: unknown): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const row = details as { queued?: unknown; comicId?: unknown; href?: unknown };
  if (row.queued !== true || typeof row.comicId !== "string" || !row.comicId) return null;
  if (typeof row.href === "string" && row.href.startsWith("/issues/")) return row.href;
  return `/issues/${row.comicId}`;
}

export function queuedMessage(resumeAt: number, timeZone = process.env.TZ || "America/Chicago"): string {
  return `Queued. Runs at ${formatPauseClock(resumeAt, timeZone)}.`;
}

export function alreadyQueuedMessage(
  row: { label: string; source: string; resumeAt: number },
  timeZone = process.env.TZ || "America/Chicago",
): string {
  return `Already queued for ${row.label} on ${queueSourceLabel(row.source)}. Runs at ${formatPauseClock(row.resumeAt, timeZone)}.`;
}

export function readQueuePayload(value: unknown): QueuePayload {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as QueuePayload) : {};
  return {
    query: typeof row.query === "string" ? row.query : undefined,
    barcode: typeof row.barcode === "string" ? row.barcode : undefined,
    mode: row.mode === "barcode" || row.mode === "query" ? row.mode : undefined,
    shelfFormat: typeof row.shelfFormat === "string" || row.shelfFormat === null ? row.shelfFormat : undefined,
    facsimile: typeof row.facsimile === "boolean" ? row.facsimile : undefined,
    shelfSeries: typeof row.shelfSeries === "string" || row.shelfSeries === null ? row.shelfSeries : undefined,
    gcdRef: typeof row.gcdRef === "string" || row.gcdRef === null ? row.gcdRef : undefined,
    hit: row.hit && typeof row.hit === "object" ? row.hit : null,
    useCover: typeof row.useCover === "boolean" ? row.useCover : undefined,
    fillMissing: typeof row.fillMissing === "boolean" ? row.fillMissing : undefined,
    overwrite: typeof row.overwrite === "boolean" ? row.overwrite : undefined,
    replaceExisting: typeof row.replaceExisting === "boolean" ? row.replaceExisting : undefined,
    coverImageUrl: typeof row.coverImageUrl === "string" || row.coverImageUrl === null ? row.coverImageUrl : undefined,
  };
}

export function storedMatchHit(value: unknown): MatchHit | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<MatchHit>;
  if (typeof row.source !== "string" || !isQueueSource(row.source) || typeof row.id !== "string" || !/^\d+$/.test(row.id)) return null;
  return {
    source: row.source,
    id: row.id,
    seriesId: typeof row.seriesId === "string" ? row.seriesId : null,
    series: typeof row.series === "string" ? row.series : "",
    issueNo: typeof row.issueNo === "string" ? row.issueNo : "",
    variant: typeof row.variant === "string" ? row.variant : null,
    coverDate: typeof row.coverDate === "string" ? row.coverDate : null,
    publisher: typeof row.publisher === "string" ? row.publisher : null,
    coverUrl: typeof row.coverUrl === "string" ? row.coverUrl : null,
    covers: Array.isArray(row.covers) ? row.covers.filter((cover) => cover && typeof cover.imageUrl === "string" && typeof cover.label === "string") : [],
    barcode: typeof row.barcode === "string" ? row.barcode : null,
    isbn: typeof row.isbn === "string" ? row.isbn : null,
    price: typeof row.price === "string" ? row.price : null,
    onSaleDate: typeof row.onSaleDate === "string" ? row.onSaleDate : null,
    coverPageUrl: typeof row.coverPageUrl === "string" ? row.coverPageUrl : null,
  };
}
