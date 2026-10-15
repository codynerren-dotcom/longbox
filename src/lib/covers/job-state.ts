import "server-only";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coversDir } from "@/lib/covers/files";
import type { EditionJobState } from "@/lib/covers/edition-job";

export type { EditionJobState } from "@/lib/covers/edition-job";
export { editionJobText } from "@/lib/covers/edition-job";

const FILE_NAME = "edition-rematch.json";

export function readEditionJob(dir = coversDir()): EditionJobState | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, FILE_NAME), "utf8")) as Partial<EditionJobState>;
    if (parsed.state !== "running" && parsed.state !== "paused" && parsed.state !== "finished") return null;
    return {
      state: parsed.state,
      message: typeof parsed.message === "string" ? parsed.message : null,
      resumeAt: typeof parsed.resumeAt === "string" ? parsed.resumeAt : null,
      metronResumeAt: typeof parsed.metronResumeAt === "string" ? parsed.metronResumeAt : null,
      matched: count(parsed.matched),
      unmatched: count(parsed.unmatched),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeEditionJob(job: Omit<EditionJobState, "updatedAt"> & { updatedAt?: string }, dir = coversDir()): EditionJobState {
  const next: EditionJobState = {
    state: job.state,
    message: job.message,
    resumeAt: job.resumeAt,
    metronResumeAt: job.metronResumeAt,
    matched: job.matched,
    unmatched: job.unmatched,
    updatedAt: job.updatedAt ?? new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, FILE_NAME), JSON.stringify(next));
  return next;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
