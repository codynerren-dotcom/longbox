import "server-only";

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coversDir } from "@/lib/covers/files";
import { formatResumeTime } from "@/lib/covers/limiter";
import { MetronBudgetError } from "@/lib/covers/types";
import { writeLog } from "@/lib/log/write";

/** Consecutive connect failures before every Metron call waits. */
export const METRON_CIRCUIT_FAILURES = 3;
/** First pause after the circuit opens. */
export const METRON_CIRCUIT_BASE_MS = 15 * 60 * 1000;
/** Longest pause while the host is still failing. */
export const METRON_CIRCUIT_MAX_MS = 2 * 60 * 60 * 1000;

const FILE_NAME = "metron-circuit.json";

type CircuitState = {
  failures: number;
  openUntil: number;
  pauseMs: number;
};

function fresh(): CircuitState {
  return { failures: 0, openUntil: 0, pauseMs: METRON_CIRCUIT_BASE_MS };
}

let memory = fresh();
let hydratedFromDb = false;
const memoryOnly = process.env.VITEST === "true";

/** Copy a database row into the in-process breaker after boot. */
export function hydrateMetronCircuit(state: CircuitState): void {
  memory = normalize(state);
  hydratedFromDb = true;
}

function circuitFile(): string {
  return path.join(coversDir(), FILE_NAME);
}

function normalize(value: unknown): CircuitState {
  const row = value && typeof value === "object" ? (value as Partial<CircuitState>) : {};
  const pauseMs =
    typeof row.pauseMs === "number" && row.pauseMs >= METRON_CIRCUIT_BASE_MS
      ? Math.min(row.pauseMs, METRON_CIRCUIT_MAX_MS)
      : METRON_CIRCUIT_BASE_MS;
  return {
    failures: typeof row.failures === "number" && row.failures > 0 ? Math.round(row.failures) : 0,
    openUntil: typeof row.openUntil === "number" && row.openUntil > 0 ? row.openUntil : 0,
    pauseMs,
  };
}

function readState(): CircuitState {
  if (memoryOnly || hydratedFromDb) return memory;
  try {
    return normalize(JSON.parse(readFileSync(circuitFile(), "utf8")));
  } catch {
    return fresh();
  }
}

function writeState(state: CircuitState): void {
  memory = state;
  hydratedFromDb = true;
  if (memoryOnly) return;
  void import("@/lib/catalog/rate-store").then((store) => store.saveCircuitWindow(state));
  try {
    mkdirSync(coversDir(), { recursive: true });
    writeFileSync(circuitFile(), JSON.stringify(state));
  } catch {
    // The database row is the copy that survives a restart.
  }
}

export function readMetronCircuit(): CircuitState {
  return { ...readState() };
}

export function resetMetronCircuit(): void {
  memory = fresh();
  if (memoryOnly) return;
  try {
    unlinkSync(circuitFile());
  } catch {
    // No file yet.
  }
}

function nestedCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function metronFailureReason(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : "Request failed.";
  const code = nestedCode(error);
  return code ? `${message} (${code})` : message;
}

/** A thrown fetch is a connect failure. An HTTP response, including 429, is a success. */
export function isMetronTransportFailure(error: unknown): boolean {
  return error instanceof Error && !(error instanceof MetronBudgetError);
}

/** Refuse the call without contacting Metron while the pause is open. */
export function assertMetronCircuit(now = Date.now()): void {
  const state = readState();
  if (state.openUntil <= now) return;
  throw new MetronBudgetError(`Metron is paused after connect failures. Resumes at ${formatResumeTime(state.openUntil)}.`, {
    budget: "Metron connect",
    count: METRON_CIRCUIT_FAILURES,
    resumeAt: state.openUntil,
  });
}

/** Any completed HTTP response clears the failure streak and the doubled pause. */
export function recordMetronTransportSuccess(now = Date.now()): void {
  const state = readState();
  if (state.failures === 0 && state.pauseMs === METRON_CIRCUIT_BASE_MS && state.openUntil <= now) return;
  writeState(fresh());
}

/**
 * Count a connect timeout or other transport failure. The caller must not retry that request.
 * The third consecutive failure pauses every Metron call. The next pause doubles, up to 2 hours.
 */
export async function recordMetronTransportFailure(error: unknown, now = Date.now()): Promise<void> {
  const state = readState();
  const failures = state.failures + 1;
  if (failures < METRON_CIRCUIT_FAILURES) {
    writeState({ ...state, failures, openUntil: state.openUntil > now ? state.openUntil : 0 });
    return;
  }
  const resumeAt = now + state.pauseMs;
  const nextPause = Math.min(state.pauseMs * 2, METRON_CIRCUIT_MAX_MS);
  writeState({ failures: 0, openUntil: resumeAt, pauseMs: nextPause });
  const reason = metronFailureReason(error);
  await writeLog({
    level: "warn",
    source: "metron",
    message: `Metron connect failed ${METRON_CIRCUIT_FAILURES} times: ${reason}. Pausing all Metron calls. Resumes at ${formatResumeTime(resumeAt)}.`,
    details: { reason, failures: METRON_CIRCUIT_FAILURES, resumeAt: new Date(resumeAt).toISOString(), pauseMs: state.pauseMs },
  });
  throw new MetronBudgetError(`Metron is paused after connect failures. Resumes at ${formatResumeTime(resumeAt)}.`, {
    budget: "Metron connect",
    count: METRON_CIRCUIT_FAILURES,
    resumeAt,
  });
}
