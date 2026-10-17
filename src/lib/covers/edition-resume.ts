import { EDITION_PAUSE_GRACE_MS, editionRunStale, type EditionJobState } from "@/lib/covers/edition-job";

export type ResumeSweepResult = "started" | "waiting" | "stale" | "idle";

/**
 * What a process-level sweep should do with the persisted job.
 * The sweep calls this on an interval started at boot, so a pause does not depend on a
 * setTimeout created inside the server action that paused the run.
 */
export function followPausedEditionJob(input: {
  job: EditionJobState | null;
  now: number;
  inflight: boolean;
  start: () => boolean;
  markStale: () => void;
  fail: (message: string) => void;
  readJob: () => EditionJobState | null;
}): ResumeSweepResult {
  const job = input.job;
  if (!job || job.state === "error" || job.state === "stale" || job.state === "finished") return "idle";
  if (job.state === "running" && !job.resumeAt) {
    if (editionRunStale(job, input.now)) {
      input.markStale();
      return "stale";
    }
    return "idle";
  }
  if (job.state !== "paused" && !(job.state === "running" && job.resumeAt)) return "idle";
  const at = job.resumeAt ? Date.parse(job.resumeAt) : Number.NaN;
  if (!Number.isFinite(at)) {
    input.fail("Edition re-match pause had no resume time.");
    return "stale";
  }
  if (at > input.now) return "waiting";
  if (input.inflight) return "waiting";
  if (input.start()) return "started";
  const latest = input.readJob();
  const nextAt = latest?.resumeAt ? Date.parse(latest.resumeAt) : Number.NaN;
  if (latest?.state === "paused" && Number.isFinite(nextAt) && nextAt > input.now) return "waiting";
  if (input.now >= at + EDITION_PAUSE_GRACE_MS) {
    input.markStale();
    return "stale";
  }
  return "waiting";
}
