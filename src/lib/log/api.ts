import { levelForStatus } from "@/lib/log/query";
import { redactString, safeUrl } from "@/lib/log/redact";
import type { LogInput, LogSource } from "@/lib/log/types";
import { writeLog } from "@/lib/log/write";

export function apiEvent(args: {
  source: LogSource;
  method?: string;
  url: string;
  startedAt: number;
  status: number | null;
  error?: string | null;
  now?: number;
  /** Metron requests already counted today, including this one. */
  dayCount?: number;
}): LogInput {
  const method = (args.method ?? "GET").toUpperCase();
  const url = safeUrl(args.url);
  const latencyMs = Math.max(0, (args.now ?? Date.now()) - args.startedAt);
  const error = args.error ? redactString(args.error) : undefined;
  const status = args.status;
  return {
    level: levelForStatus(status, error),
    source: args.source,
    message: `${method} ${url} → ${status ?? "failed"} (${latencyMs}ms)`,
    details: {
      method,
      url,
      status,
      latencyMs,
      ...(args.dayCount != null ? { dayCount: args.dayCount } : {}),
      ...(error ? { error } : {}),
    },
  };
}

export async function recordFetch(args: {
  source: LogSource;
  method?: string;
  url: string;
  startedAt: number;
  status: number | null;
  error?: string | null;
  now?: number;
  dayCount?: number;
}): Promise<void> {
  await writeLog(apiEvent(args));
}
