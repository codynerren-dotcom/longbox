import { describe, expect, it } from "vitest";
import { apiEvent } from "@/lib/log/api";
import {
  changedKeys,
  coverLineLevel,
  dateWindow,
  formatLogText,
  levelForStatus,
  logFiltersFrom,
  logQueryString,
  logWhere,
  retentionCutoff,
  serverErrorDetails,
  zonedDayStart,
} from "@/lib/log/query";
import { redactString, redactValue, safeUrl } from "@/lib/log/redact";
import { loggingEnabled } from "@/lib/log/write";
import { defaultPreferences, normalizePreferences, preferencesFromForm, retentionDays } from "@/lib/settings/preferences";

describe("log redaction", () => {
  it("strips secrets, tokens, and auth headers", () => {
    expect(redactValue({ password: "hunter2", note: "kept" })).toEqual({ password: "redacted", note: "kept" });
    expect(redactValue({ Authorization: "Basic abcdef", Accept: "application/json" })).toEqual({
      Authorization: "redacted",
      Accept: "application/json",
    });
    expect(redactValue({ nested: { api_key: "secret", note: "Bearer tok_123" } })).toEqual({
      nested: { api_key: "redacted", note: "Bearer redacted" },
    });
    expect(redactString("client_secret=abc&ok=1")).toBe("client_secret=redacted&ok=1");
    expect(redactString("Updated metron.password")).toBe("Updated metron.password");
  });

  it("removes credentials from request URLs", () => {
    const safe = safeUrl("https://user:secret@comicvine.gamespot.com/api/issues/?api_key=super-secret&format=json");
    expect(safe).not.toContain("super-secret");
    expect(safe).not.toContain("user:secret");
    expect(safe).toContain("format=json");
    expect(safe).toContain("api_key=redacted");
  });

  it("records status and latency without the credential that was sent", () => {
    const event = apiEvent({
      source: "comicvine",
      method: "GET",
      url: "https://user:secret@comicvine.gamespot.com/api/issues/?api_key=super-secret&format=json",
      startedAt: 1000,
      status: 401,
      error: "Authorization: Bearer abc.def.ghi",
      now: 1042,
    });
    const blob = JSON.stringify(event);
    expect(blob).not.toContain("super-secret");
    expect(blob).not.toContain("abc.def");
    expect(blob).not.toContain("user:secret");
    expect(event.level).toBe("warn");
    expect(event.source).toBe("comicvine");
    expect(event.details).toMatchObject({ status: 401, latencyMs: 42, method: "GET" });
    expect(levelForStatus(200, null)).toBe("info");
    expect(levelForStatus(429, null)).toBe("warn");
    expect(levelForStatus(503, null)).toBe("error");
    expect(levelForStatus(null, "down")).toBe("error");
  });
});

describe("log retention and filters", () => {
  it("defaults to 30 days and clamps the setting", () => {
    expect(defaultPreferences().logs.retentionDays).toBe(30);
    expect(retentionDays("14")).toBe(14);
    expect(retentionDays("0")).toBe(1);
    expect(retentionDays("nope")).toBe(30);
    expect(retentionDays(99999)).toBe(3650);
    const now = new Date("2026-10-14T12:00:00.000Z");
    expect(retentionCutoff(now, 30).toISOString()).toBe("2026-09-14T12:00:00.000Z");
    const form = new FormData();
    form.set("logRetentionDays", "14");
    expect(preferencesFromForm(form, defaultPreferences()).logs.retentionDays).toBe(14);
    expect(preferencesFromForm(new FormData(), normalizePreferences({ logs: { retentionDays: 9 } })).logs.retentionDays).toBe(9);
  });

  it("filters by level, source, search, and the saved timezone", () => {
    expect(zonedDayStart("2026-10-14", "America/Chicago")?.toISOString()).toBe("2026-10-14T05:00:00.000Z");
    expect(zonedDayStart("2026-10-14", "UTC")?.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(dateWindow("2026-10-14", "2026-10-14", "UTC")).toEqual({
      gte: new Date("2026-10-14T00:00:00.000Z"),
      lt: new Date("2026-10-15T00:00:00.000Z"),
    });
    expect(
      logWhere({ level: "warn", source: "import", q: "row", from: "2026-10-14", to: "2026-10-14" }, "UTC"),
    ).toEqual({
      level: "warn",
      source: "import",
      message: { contains: "row", mode: "insensitive" },
      createdAt: { gte: new Date("2026-10-14T00:00:00.000Z"), lt: new Date("2026-10-15T00:00:00.000Z") },
    });
    expect(logWhere(logFiltersFrom({ level: "nope", q: "  " }), "UTC")).toEqual({});
    expect(logQueryString({ level: "error", source: "scan", q: "barcode", from: "", to: "" }, "json")).toBe(
      "?level=error&source=scan&q=barcode&format=json",
    );
  });

  it("exports text in the display clock and still redacts stored details", () => {
    const text = formatLogText(
      [
        {
          id: "1",
          level: "info",
          source: "settings",
          message: "Updated metron.password",
          details: { keys: ["metron.password"], password: "hunter2", Authorization: "Bearer tok_123" },
          createdAt: new Date("2020-06-15T12:00:00.000Z"),
        },
      ],
      { timeZone: "America/Chicago", clock: "12", dateFormat: "mdy", withTime: true },
    );
    expect(text).toContain("Jun 15, 2020");
    expect(text).toContain("info");
    expect(text).toContain("settings");
    expect(text).toContain("Updated metron.password");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("tok_123");
  });

  it("names changed preference keys and leaves the values out", () => {
    const before = defaultPreferences();
    const after = normalizePreferences({ display: { accent: "blue" }, logs: { retentionDays: 14 } }, before);
    expect(changedKeys(before, after)).toEqual(["display.accent", "logs.retentionDays"]);
    expect(JSON.stringify(changedKeys(before, after))).not.toContain("blue");
  });

  it("classifies cover lines and redacts unhandled error paths", () => {
    expect(coverLineLevel("Saga #1 matched Metron 10 via barcode")).toBe("info");
    expect(coverLineLevel("Saga #1 unmatched: no issue")).toBe("warn");
    expect(coverLineLevel("Metron rate limit reached. Stopping so the run can resume.")).toBe("warn");
    const details = serverErrorDetails({
      path: "/api/lookup?barcode=1&api_key=super-secret",
      method: "GET",
      routePath: "/api/lookup",
    });
    expect(JSON.stringify(details)).not.toContain("super-secret");
    expect(details.method).toBe("GET");
    expect(loggingEnabled()).toBe(false);
  });
});
