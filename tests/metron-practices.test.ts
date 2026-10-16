import { afterEach, describe, expect, it, vi } from "vitest";
import { searchMetronMatches } from "@/lib/catalog/match-search";
import { emptyMetronBudget } from "@/lib/catalog/rate-limit";
import { saveMetronWindow } from "@/lib/catalog/rate-store";
import { resolveCover } from "@/lib/covers/match";
import {
  METRON_5XX_BASE_MS,
  METRON_5XX_CAP_MS,
  budgetDay,
  emptyBudget,
  metronStatusPlan,
  MetronLimiter,
  type BudgetStore,
  type MetronBudget,
} from "@/lib/covers/limiter";
import {
  METRON_CIRCUIT_BASE_MS,
  hydrateMetronCircuit,
  readMetronCircuit,
  resetMetronCircuit,
} from "@/lib/covers/metron-circuit";
import { downloadCover } from "@/lib/covers/files";
import { METRON_USER_AGENT } from "@/lib/covers/metron-headers";
import {
  clearMetronDetailCache,
  createMetronCoverLookup,
  fetchMetronIssueBody,
  fetchMetronSeriesRun,
  metronConnectHold,
  nextMetronQueueAt,
  type MetronTransport,
} from "@/lib/covers/metron-client";
import { MetronConnectError, type CoverQuery } from "@/lib/covers/types";
import * as logWrite from "@/lib/log/write";

const image = "https://static.metron.cloud/media/issue/saga-1.jpg";

function storeOf(seed: Partial<MetronBudget> = {}): { store: BudgetStore; budget: MetronBudget } {
  const budget: MetronBudget = { ...emptyBudget(), day: "2026-10-16", ...seed };
  return {
    budget,
    store: {
      read: () => ({ ...budget }),
      write: (next) => Object.assign(budget, next),
    },
  };
}

function transport(args: {
  fetch: MetronTransport["fetch"];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budget?: Partial<MetronBudget>;
  password?: string;
}): { transport: MetronTransport; limiter: MetronLimiter } {
  const { store } = storeOf(args.budget);
  const now = args.now ?? (() => 0);
  const limiter = new MetronLimiter(store, now, args.sleep ?? (async () => undefined), () => "2026-10-16");
  return {
    limiter,
    transport: {
      limiter,
      username: "cody",
      password: args.password ?? "s3cr3t-token",
      baseUrl: "https://metron.cloud/api",
      now,
      fetch: args.fetch,
    },
  };
}

function sagaIssue() {
  return {
    id: 50,
    series: { id: 15, name: "Saga", year_began: 2012, publisher: { name: "Image" } },
    number: "1",
    issue: "Saga (2012) #1",
    cover_date: "2012-03-01",
    image,
  };
}

afterEach(async () => {
  resetMetronCircuit();
  clearMetronDetailCache();
  await saveMetronWindow(emptyMetronBudget());
  vi.restoreAllMocks();
});

describe("Metron request practices", () => {
  it("looks up an issue with series name, number, and series year in one request", async () => {
    const urls: string[] = [];
    const { transport: client } = transport({
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json({ results: [sagaIssue()] });
      },
    });
    const comic: CoverQuery = {
      series: "Saga (2012)",
      issueNo: "1",
      issue: "1",
      coverYear: 2012,
      barcode: null,
      variant: null,
      publisher: "Image",
      seriesYear: 2012,
    };
    const decision = await resolveCover(comic, createMetronCoverLookup(client));
    expect(decision).toMatchObject({ status: "matched", issue: { id: "50" } });
    expect(urls).toHaveLength(1);
    const params = new URL(urls[0] ?? "").searchParams;
    expect(params.get("series_name")).toBe("Saga");
    expect(params.get("number")).toBe("1");
    expect(params.get("series_year_began")).toBe("2012");
    expect(urls[0]).not.toContain("/series/?");

    const searched: string[] = [];
    await searchMetronMatches(
      transport({
        fetch: async (url) => {
          searched.push(String(url));
          return Response.json({ results: [sagaIssue()] });
        },
      }).transport,
      "Saga 2012 #1",
      "",
      "query",
    );
    expect(searched[0]).toContain("series_name=Saga");
    expect(searched[0]).toContain("number=1");
    expect(searched[0]).toContain("series_year_began=2012");
    expect(searched[0]).not.toContain("cover_year=");
  });

  it("pages a stored series id from issue_list and never loads the series detail", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const urls: string[] = [];
    const run = await fetchMetronSeriesRun(
      transport({
        fetch: async (url) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          urls.push(String(url));
          await Promise.resolve();
          inFlight -= 1;
          if (String(url).includes("page=2")) {
            return Response.json({ count: 4, next: null, results: [{ number: "3" }] });
          }
          return Response.json({
            count: 4,
            next: "https://metron.cloud/api/series/3364/issue_list/?page=2",
            results: [{ number: "1" }, { number: "2" }],
          });
        },
      }).transport,
      "3364",
    );
    expect(urls[0]).toBe("https://metron.cloud/api/series/3364/issue_list/");
    expect(urls[1]).toBe("https://metron.cloud/api/series/3364/issue_list/?page=2");
    expect(urls.some((url) => /\/series\/3364\/?$/.test(url))).toBe(false);
    expect(maxInFlight).toBe(1);
    expect(run).toEqual({ numbers: ["1", "2", "3"], issueCount: 4 });
  });

  it("does not fetch issue detail while searching a barcode list", async () => {
    const urls: string[] = [];
    const { transport: client } = transport({
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json({
          results: [
            { id: 101, series: { id: 8, name: "Spawn", year_began: 1992 }, number: "1", image },
            { id: 122, series: { id: 8, name: "Spawn", year_began: 1992 }, number: "22", image },
          ],
        });
      },
    });
    const hits = await createMetronCoverLookup(client).issuesByUpc("70985300001100111");
    expect(hits.map((hit) => hit.id)).toEqual(["101", "122"]);
    expect(urls).toEqual(["https://metron.cloud/api/issue/?upc=70985300001100111"]);
  });

  it("sends If-Modified-Since on a detail refetch and keeps the cached body on 304", async () => {
    clearMetronDetailCache();
    const modified = "Wed, 21 Oct 2015 07:28:00 GMT";
    let calls = 0;
    const { transport: client, limiter } = transport({
      fetch: async (_url, init) => {
        calls += 1;
        const headers = init?.headers as Record<string, string>;
        if (calls === 1) {
          expect(headers["If-Modified-Since"]).toBeUndefined();
          return Response.json({ id: 9, number: "1", series: { name: "Saga" } }, { headers: { "Last-Modified": modified } });
        }
        expect(headers["If-Modified-Since"]).toBe(modified);
        return new Response(null, { status: 304 });
      },
    });
    const first = await fetchMetronIssueBody(client, "9");
    const second = await fetchMetronIssueBody(client, "9");
    expect(second).toEqual(first);
    expect(calls).toBe(2);
    expect(limiter.snapshot().count).toBe(2);
  });

  it("retries 429 until the burst reset, then pauses, and does not retry other 4xx", async () => {
    const now = 1_780_000_000_000;
    const reset = Math.floor(now / 1000) + 45;
    expect(
      metronStatusPlan({
        status: 429,
        headers: new Headers({ "retry-after": "5", "x-ratelimit-burst-reset": String(reset) }),
        body: "",
        attempt: 1,
        now,
        lane: "interactive",
      }),
    ).toEqual({ action: "retry", waitMs: 45_000 });
    expect(
      metronStatusPlan({
        status: 404,
        headers: new Headers(),
        body: "",
        attempt: 1,
        now,
        lane: "interactive",
      }).action,
    ).toBe("fail");

    let time = now;
    const waits: number[] = [];
    let calls = 0;
    const { transport: client } = transport({
      now: () => time,
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
      },
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("slow", {
            status: 429,
            headers: { "retry-after": "5", "x-ratelimit-burst-reset": String(reset) },
          });
        }
        return Response.json({ results: [] });
      },
    });
    await createMetronCoverLookup(client).issuesByUpc("1");
    expect(waits).toContain(45_000);
    expect(waits).not.toContain(5_000);
    expect(calls).toBe(2);

    let again = 0;
    const paused = transport({
      now: () => now,
      fetch: async () => {
        again += 1;
        return new Response("slow", { status: 429, headers: { "retry-after": "10" } });
      },
    });
    await expect(createMetronCoverLookup(paused.transport).issuesByUpc("1")).rejects.toMatchObject({
      pause: { budget: "Metron rate limit", resumeAt: now + 10_000 },
    });
    expect(again).toBe(2);

    let missing = 0;
    const notFound = transport({
      fetch: async () => {
        missing += 1;
        return new Response("no", { status: 404 });
      },
    });
    await expect(createMetronCoverLookup(notFound.transport).issuesByUpc("1")).rejects.toThrow(/404/);
    expect(missing).toBe(1);
  });

  it("backs off 5xx from 1s to 60s and does not retry a connect timeout", async () => {
    expect(METRON_5XX_BASE_MS).toBe(1_000);
    expect(METRON_5XX_CAP_MS).toBe(60_000);
    const waits = [1, 2, 3, 4, 5, 6, 7].map(
      (attempt) =>
        metronStatusPlan({
          status: 503,
          headers: new Headers(),
          body: "",
          attempt,
          now: 0,
          lane: "interactive",
        }),
    );
    expect(waits.map((plan) => (plan.action === "retry" ? plan.waitMs : 0))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
    expect(
      metronStatusPlan({ status: 503, headers: new Headers(), body: "", attempt: 8, now: 0, lane: "interactive" }).action,
    ).toBe("fail");

    let time = 0;
    const slept: number[] = [];
    let calls = 0;
    const { transport: client } = transport({
      budget: { burstLimit: 60_000 },
      now: () => time,
      sleep: async (ms) => {
        slept.push(ms);
        time += ms;
      },
      fetch: async () => {
        calls += 1;
        if (calls < 3) return new Response("down", { status: 500 });
        return Response.json({ results: [] });
      },
    });
    await createMetronCoverLookup(client).issuesByUpc("1");
    expect(slept.slice(0, 2)).toEqual([1_000, 2_000]);
    expect(calls).toBe(3);

    resetMetronCircuit();
    let connects = 0;
    const broken = transport({
      fetch: async () => {
        connects += 1;
        throw new Error("connect ETIMEDOUT");
      },
    });
    await expect(createMetronCoverLookup(broken.transport).issuesByUpc("1")).rejects.toBeInstanceOf(MetronConnectError);
    expect(connects).toBe(1);
    expect(readMetronCircuit().failures).toBe(1);
    expect(readMetronCircuit().openUntil).toBe(0);
  });

  it("pauses before burst remaining hits 0 and holds a closed breaker for at least 30 minutes", async () => {
    expect(METRON_CIRCUIT_BASE_MS).toBe(30 * 60 * 1000);
    let calls = 0;
    const blocked = transport({
      budget: { burstRemaining: 1, burstLimit: 20, burstResetAt: 60_000 },
      fetch: async () => {
        calls += 1;
        return Response.json({ results: [] });
      },
    });
    await expect(createMetronCoverLookup(blocked.transport).issuesByUpc("1")).rejects.toMatchObject({
      pause: { budget: "Metron burst" },
    });
    expect(calls).toBe(0);

    const now = 5_000;
    hydrateMetronCircuit({ failures: 0, openUntil: now + METRON_CIRCUIT_BASE_MS, pauseMs: METRON_CIRCUIT_BASE_MS });
    expect(nextMetronQueueAt(now)).toBe(now + METRON_CIRCUIT_BASE_MS);
    expect(metronConnectHold(now)).toBe(now + METRON_CIRCUIT_BASE_MS);

    resetMetronCircuit();
    await saveMetronWindow({
      ...emptyMetronBudget(),
      day: budgetDay(new Date(now)),
      burstRemaining: 1,
      burstLimit: 20,
      burstResetAt: 65_000,
    });
    expect(nextMetronQueueAt(now)).toBe(65_000);
  });

  it("logs the running daily count and leaves credentials out of the log", async () => {
    const entries: Array<{ message: string; details?: unknown }> = [];
    vi.spyOn(logWrite, "writeLog").mockImplementation(async (input) => {
      entries.push({ message: input.message, details: input.details });
    });
    const password = "s3cr3t-token";
    const { transport: client } = transport({
      password,
      fetch: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization?.startsWith("Basic ")).toBe(true);
        return Response.json({ results: [] });
      },
    });
    await createMetronCoverLookup(client).issuesByUpc("07596060000100001");
    const logged = JSON.stringify(entries);
    expect(entries.some((entry) => (entry.details as { dayCount?: number } | undefined)?.dayCount === 1)).toBe(true);
    expect(logged).not.toContain(password);
    expect(logged).not.toContain("Basic ");
    expect(logged.toLowerCase()).not.toContain("authorization");
  });

  it("names Longbox in the User-Agent and can send a Bearer token", async () => {
    const built = transport({
      fetch: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers["User-Agent"]).toBe(METRON_USER_AGENT);
        expect(headers.Accept).toBe("application/json");
        expect(headers.Authorization).toBe("Bearer tok_123");
        return Response.json({ results: [] });
      },
    });
    built.transport.authorization = "Bearer tok_123";
    await createMetronCoverLookup(built.transport).issuesByUpc("1");
  });

  it("sends If-Modified-Since when a stored series issue list is fetched again", async () => {
    clearMetronDetailCache();
    const modified = "Wed, 12 Feb 2026 10:30:00 GMT";
    let calls = 0;
    const page = { count: 1, next: null, results: [{ number: "1" }] };
    const client = transport({
      fetch: async (_url, init) => {
        calls += 1;
        const headers = init?.headers as Record<string, string>;
        if (calls === 1) {
          expect(headers["If-Modified-Since"]).toBeUndefined();
          return Response.json(page, { headers: { "Last-Modified": modified } });
        }
        expect(headers["If-Modified-Since"]).toBe(modified);
        return new Response(null, { status: 304 });
      },
    }).transport;
    const first = await fetchMetronSeriesRun(client, "15");
    const second = await fetchMetronSeriesRun(client, "15");
    expect(second).toEqual(first);
    expect(calls).toBe(2);
  });

  it("sends the User-Agent when downloading a Metron cover", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("user-agent")).toBe(METRON_USER_AGENT);
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const filename = await downloadCover("https://static.metron.cloud/media/issue/saga-1.jpg", "50", "/tmp/longbox-cover-test", {
        force: true,
      });
      expect(filename.startsWith("metron-50")).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
