const SECRET_KEY = /(password|passwd|secret|token|authorization|api[_-]?key|credential|cookie)/i;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "redacted";
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "redacted" : redactValue(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  return undefined;
}

export function redactString(value: string): string {
  return value
    .replace(/\b(basic|bearer)\s+\S+/gi, "$1 redacted")
    .replace(/((?:api[_-]?key|token|password|client[_-]?secret|authorization)=)[^&\s]+/gi, "$1redacted");
}

export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return redactString(raw);
  }
}
