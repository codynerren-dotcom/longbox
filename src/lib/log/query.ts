import type { Prisma } from "@prisma/client";
import type { DateDisplay } from "@/lib/format";
import { formatDate } from "@/lib/format";
import { redactString, redactValue, safeUrl } from "@/lib/log/redact";
import { isLogLevel, isLogSource, type LogLevel } from "@/lib/log/types";
import { retentionDays } from "@/lib/settings/preferences";

export type LogFilters = {
  level: string;
  source: string;
  q: string;
  from: string;
  to: string;
};

export function emptyLogFilters(): LogFilters {
  return { level: "", source: "", q: "", from: "", to: "" };
}

export function logFiltersFrom(params: URLSearchParams | Record<string, string | string[] | undefined>): LogFilters {
  return {
    level: first(read(params, "level")),
    source: first(read(params, "source")),
    q: first(read(params, "q")).slice(0, 200),
    from: day(first(read(params, "from"))),
    to: day(first(read(params, "to"))),
  };
}

export function logWhere(filters: LogFilters, timeZone: string): Prisma.AppLogWhereInput {
  const where: Prisma.AppLogWhereInput = {};
  if (isLogLevel(filters.level)) where.level = filters.level;
  if (isLogSource(filters.source)) where.source = filters.source;
  const q = filters.q.trim();
  if (q) where.message = { contains: q, mode: "insensitive" };
  const window = dateWindow(filters.from, filters.to, timeZone);
  if (window) where.createdAt = window;
  return where;
}

export function retentionCutoff(now: Date, days: number): Date {
  const safe = retentionDays(days);
  return new Date(now.getTime() - safe * 24 * 60 * 60 * 1000);
}

export function dateWindow(from: string, to: string, timeZone: string): { gte?: Date; lt?: Date } | null {
  const range: { gte?: Date; lt?: Date } = {};
  if (from) {
    const start = zonedDayStart(from, timeZone);
    if (start) range.gte = start;
  }
  if (to) {
    const start = zonedDayStart(to, timeZone);
    if (start) range.lt = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  }
  if (!range.gte && !range.lt) return null;
  return range;
}

export function zonedDayStart(day: string, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const utcGuess = Date.UTC(year, month - 1, date, 0, 0, 0);
  let instant = utcGuess - zoneOffsetMs(new Date(utcGuess), timeZone);
  instant = utcGuess - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

export function logQueryString(filters: LogFilters, format?: "text" | "json"): string {
  const params = new URLSearchParams();
  if (isLogLevel(filters.level)) params.set("level", filters.level);
  if (isLogSource(filters.source)) params.set("source", filters.source);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (format) params.set("format", format);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type LogRow = {
  id: string;
  level: string;
  source: string;
  message: string;
  details: unknown;
  createdAt: Date;
};

export function serializeLog(row: LogRow) {
  return {
    id: row.id,
    level: row.level,
    source: row.source,
    message: redactString(row.message),
    details: row.details == null ? null : redactValue(row.details),
    createdAt: row.createdAt.toISOString(),
  };
}

export function formatLogText(rows: LogRow[], display: DateDisplay): string {
  return rows
    .map((row) => {
      const when = formatDate(row.createdAt, { ...display, withTime: true });
      const safe = serializeLog(row);
      const head = `${when}\t${safe.level}\t${safe.source}\t${safe.message}`;
      if (safe.details == null) return head;
      return `${head}\n${JSON.stringify(safe.details)}`;
    })
    .join("\n");
}

export function levelForStatus(status: number | null, error?: string | null): LogLevel {
  if (status == null || status >= 500) return "error";
  if (status === 429 || status >= 400) return "warn";
  if (error) return "error";
  return "info";
}

export function coverLineLevel(line: string): LogLevel {
  if (/rate limit|unmatched|paused|fail|error|stopped/i.test(line)) return "warn";
  return "info";
}

export function serverErrorDetails(args: { path: string; method: string; routePath?: string; digest?: string }) {
  return {
    path: safeUrl(args.path.startsWith("http") ? args.path : `http://local${args.path.startsWith("/") ? "" : "/"}${args.path}`).replace(/^http:\/\/local/, "") || "/",
    method: args.method,
    routePath: args.routePath,
    digest: args.digest,
  };
}

export function changedKeys(before: unknown, after: unknown): string[] {
  const keys: string[] = [];
  walk(before, after, "", keys);
  return keys;
}

function walk(before: unknown, after: unknown, path: string, keys: string[]) {
  if (Array.isArray(before) || Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after) && path) keys.push(path);
    return;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      walk(left[key], right[key], path ? `${path}.${key}` : key, keys);
    }
    return;
  }
  if (before !== after && path) keys.push(path);
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  let zone = timeZone;
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(date);
  } catch {
    zone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return asUtc - date.getTime();
}

function first(value: string): string {
  return value.trim();
}

function read(params: URLSearchParams | Record<string, string | string[] | undefined>, key: string): string {
  if (params instanceof URLSearchParams) return params.get(key) ?? "";
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function day(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}
