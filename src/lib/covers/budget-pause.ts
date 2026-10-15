import { GcdBudgetError } from "@/lib/catalog/gcd";
import { formatResumeTime, nextBudgetDayStart } from "@/lib/covers/limiter";
import { MetronBudgetError, type BudgetPause } from "@/lib/covers/types";
import { writeLog } from "@/lib/log/write";

export function budgetPauseMessage(job: string, pause: BudgetPause): string {
  const count = pause.count == null ? "" : ` (${pause.count} requests)`;
  const when = pause.resumeAt > 0 ? formatResumeTime(pause.resumeAt) : "the budget resets";
  return `${job} paused for the ${pause.budget} budget${count}. Resumes at ${when}.`;
}

export function pauseOf(error: MetronBudgetError | GcdBudgetError, now = Date.now()): BudgetPause {
  if (error.pause.resumeAt > 0) return error.pause;
  return { ...error.pause, resumeAt: nextBudgetDayStart(now) };
}

/** Info row for a background job that is waiting on a catalog budget. */
export async function recordBudgetPause(job: string, error: MetronBudgetError | GcdBudgetError, now = Date.now()): Promise<BudgetPause> {
  const pause = pauseOf(error, now);
  await writeLog({
    level: "info",
    source: "covers/backfill",
    message: budgetPauseMessage(job, pause),
    details: {
      budget: pause.budget,
      count: pause.count,
      resumeAt: new Date(pause.resumeAt).toISOString(),
    },
  });
  return pause;
}
