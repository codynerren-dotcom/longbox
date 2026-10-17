import "server-only";

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { editionJobFromUnknown, type EditionJobState } from "@/lib/covers/edition-job";
import { coversDir } from "@/lib/covers/files";

export type { EditionJobState } from "@/lib/covers/edition-job";
export { editionJobText, editionSummaryText } from "@/lib/covers/edition-job";

const FILE_NAME = "edition-rematch.json";

export type EditionJobWrite = Omit<
  EditionJobState,
  | "updatedAt"
  | "attempted"
  | "proposed"
  | "noCandidate"
  | "skipped"
  | "cursorId"
  | "cursorAt"
  | "cursorSettled"
  | "attempts"
  | "heartbeatAt"
  | "runId"
  | "mode"
  | "scope"
  | "misses"
  | "metronCalls"
  | "metronDay"
> &
  Partial<
    Pick<
      EditionJobState,
      | "updatedAt"
      | "attempted"
      | "proposed"
      | "noCandidate"
      | "skipped"
      | "cursorId"
      | "cursorAt"
      | "cursorSettled"
      | "attempts"
      | "heartbeatAt"
      | "runId"
      | "mode"
      | "scope"
      | "misses"
      | "metronCalls"
      | "metronDay"
    >
  >;

export function readEditionJob(dir = coversDir()): EditionJobState | null {
  try {
    return editionJobFromUnknown(JSON.parse(readFileSync(path.join(dir, FILE_NAME), "utf8")));
  } catch {
    return null;
  }
}

export function writeEditionJob(job: EditionJobWrite, dir = coversDir()): EditionJobState {
  const next = editionJobFromUnknown({
    ...job,
    updatedAt: job.updatedAt ?? new Date().toISOString(),
  });
  if (!next) throw new Error("Edition re-match job could not be stored.");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, FILE_NAME), JSON.stringify(next));
  return next;
}

export function deleteEditionJob(dir = coversDir()): void {
  try {
    unlinkSync(path.join(dir, FILE_NAME));
  } catch {
    // Already gone.
  }
}
