import { formatResumeTime } from "@/lib/covers/limiter";

export type EditionJobState = {
  state: "running" | "paused" | "finished";
  message: string | null;
  resumeAt: string | null;
  metronResumeAt: string | null;
  matched: number;
  unmatched: number;
  updatedAt: string;
};

/** Label for Settings and Logs. No filesystem access, so client components can use it. */
export function editionJobText(job: EditionJobState | null): string | null {
  if (!job) return null;
  if (job.state === "running") return "Edition re-match: running";
  if (job.state === "finished") return "Edition re-match: finished";
  if (job.resumeAt) {
    const at = Date.parse(job.resumeAt);
    const when = Number.isFinite(at) ? formatResumeTime(at) : job.resumeAt;
    return `Edition re-match: paused until ${when}`;
  }
  return "Edition re-match: paused";
}
