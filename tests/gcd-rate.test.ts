import { afterEach, describe, expect, it, vi } from "vitest";
import { GcdBudgetError, createGcdCatalog, gcdRatePauseMessage, gcdRetryDelay, resetGcdBudget } from "@/lib/catalog/gcd";
import * as logWrite from "@/lib/log/write";

describe("GCD 429 backoff", () => {
  afterEach(() => {
    resetGcdBudget();
    vi.restoreAllMocks();
  });

  it("climbs 30s, 1m, 2m, 5m, then stays at 10m when Retry-After is missing", () => {
    resetGcdBudget();
    expect(gcdRetryDelay(null)).toBe(30_000);
    expect(gcdRetryDelay(null)).toBe(60_000);
    expect(gcdRetryDelay(null)).toBe(120_000);
    expect(gcdRetryDelay(null)).toBe(300_000);
    expect(gcdRetryDelay(null)).toBe(600_000);
    expect(gcdRetryDelay(null)).toBe(600_000);
    expect(gcdRatePauseMessage(30_000, 0)).toContain("Pausing for 30s");
    expect(gcdRatePauseMessage(60_000, 0)).toContain("Pausing for 1m");
    expect(gcdRatePauseMessage(120_000, 0)).toContain("Pausing for 2m");
    expect(gcdRatePauseMessage(300_000, 0)).toContain("Pausing for 5m");
    expect(gcdRatePauseMessage(600_000, 0)).toContain("Pausing for 10m");
  });

  it("keeps a Retry-After or an expected-available hint ahead of the fallback", () => {
    resetGcdBudget();
    expect(gcdRetryDelay(15_000)).toBe(15_000);
    expect(gcdRetryDelay(null)).toBe(30_000);
  });

  it("logs a 30s pause when comics.org returns 429 with no Retry-After", async () => {
    resetGcdBudget();
    const logs: string[] = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      logs.push(input.message);
    });
    const catalog = createGcdCatalog(async () => new Response("slow down", { status: 429, headers: { "content-type": "text/plain" } }));
    const started = Date.now();
    let pauseAt = 0;
    try {
      await catalog.seriesByName("Beneath the Trees");
    } catch (error) {
      expect(error).toBeInstanceOf(GcdBudgetError);
      pauseAt = error instanceof GcdBudgetError ? error.pause.resumeAt : 0;
    }
    expect(pauseAt - started).toBeGreaterThanOrEqual(29_000);
    expect(pauseAt - started).toBeLessThan(35_000);
    expect(logs.some((line) => line.includes("Pausing for 30s"))).toBe(true);
  });

  it("logs the header delay when Retry-After is present", async () => {
    resetGcdBudget();
    const logs: string[] = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      logs.push(input.message);
    });
    const catalog = createGcdCatalog(
      async () => new Response("Expected available in 90 seconds", { status: 429, headers: { "retry-after": "15", "content-type": "text/plain" } }),
    );
    const started = Date.now();
    let pauseAt = 0;
    try {
      await catalog.seriesByName("Beneath the Trees");
    } catch (error) {
      pauseAt = error instanceof GcdBudgetError ? error.pause.resumeAt : 0;
    }
    expect(pauseAt - started).toBeGreaterThanOrEqual(14_000);
    expect(pauseAt - started).toBeLessThan(20_000);
    expect(logs.some((line) => line.includes("Pausing for 15s"))).toBe(true);
  });
});
