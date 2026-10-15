export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const LOG_SOURCES = [
  "import",
  "covers/backfill",
  "metron",
  "comicvine",
  "gcd",
  "ebay/pricing",
  "scan",
  "settings",
  "system",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogSource = (typeof LOG_SOURCES)[number];

export const SOURCE_LABELS: Record<LogSource, string> = {
  import: "Import",
  "covers/backfill": "Covers",
  metron: "Metron",
  comicvine: "Comic Vine",
  gcd: "GCD",
  "ebay/pricing": "eBay",
  scan: "Scan",
  settings: "Settings",
  system: "System",
};

export type LogInput = {
  level: LogLevel;
  source: LogSource;
  message: string;
  details?: unknown;
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function isLogSource(value: string): value is LogSource {
  return (LOG_SOURCES as readonly string[]).includes(value);
}
