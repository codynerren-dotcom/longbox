import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testEbayConnection } from "@/lib/pricing/ebay";
import { decryptSecret, encryptSecret, parseSecretKey, SettingsCryptoError } from "@/lib/settings/crypto";
import { ensureSecretKey } from "@/lib/settings/key";
import { probeComicVine, probeEbay, probeMetron } from "@/lib/settings/probe";
import {
  buildConfig,
  metronAuthorization,
  readEnv,
  SECRET_MASK,
  type EnvSnapshot,
  type IntegrationConfig,
  type StoredSettings,
} from "@/lib/settings/resolve";
import { createSettingsService, shouldSeedShelf, type SettingRow, type SettingsRepository } from "@/lib/settings/service";

const key = parseSecretKey(Buffer.alloc(32, 7).toString("base64"));

function env(overrides: Partial<EnvSnapshot> = {}): EnvSnapshot {
  return { ...readEnv({} as NodeJS.ProcessEnv), ...overrides };
}

function memoryRepo(rows: SettingRow[] = []): SettingsRepository & { rows: SettingRow[] } {
  const stored = [...rows];
  return {
    rows: stored,
    async readAll() {
      return stored.map((row) => ({ ...row }));
    },
    async upsert(row) {
      const index = stored.findIndex((item) => item.key === row.key);
      if (index >= 0) stored[index] = row;
      else stored.push(row);
    },
    async delete(keyName) {
      const index = stored.findIndex((item) => item.key === keyName);
      if (index >= 0) stored.splice(index, 1);
    },
  };
}

function emptyStored(): StoredSettings {
  return { secrets: {}, seedOnEmpty: null };
}

describe("settings crypto", () => {
  it("round-trips a secret and rejects the wrong key or a tampered payload", () => {
    const payload = encryptSecret("metron-password-9", key);
    expect(decryptSecret(payload, key)).toBe("metron-password-9");
    expect(() => decryptSecret(payload, parseSecretKey(Buffer.alloc(32, 8).toString("base64")))).toThrow(SettingsCryptoError);
    const [version, body] = payload.split(".");
    const flipped = Buffer.from(body, "base64");
    flipped[flipped.length - 1] ^= 0xff;
    expect(() => decryptSecret(`${version}.${flipped.toString("base64")}`, key)).toThrow(/could not be decrypted/);
    expect(() => parseSecretKey("short")).toThrow(SettingsCryptoError);
  });

  it("writes a key file on first use and reads it the next time", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "longbox-key-"));
    const filePath = path.join(directory, "longbox-secret.key");
    let written = "";
    const first = ensureSecretKey({
      envValue: "",
      filePath,
      read: () => (written ? written : null),
      write: (_file, contents) => {
        written = contents;
      },
      random: () => Buffer.alloc(32, 4),
    });
    const second = ensureSecretKey({
      envValue: "  ",
      filePath,
      read: () => written,
      write: () => {
        throw new Error("should not rotate the key");
      },
    });
    expect(first.equals(second)).toBe(true);
    expect(written.trim().length).toBeGreaterThan(40);
  });
});

describe("settings resolution", () => {
  it("lets a database secret override the environment and falls back after clear", async () => {
    const repo = memoryRepo();
    const service = createSettingsService({
      repo,
      key,
      env: env({
        metronUsername: "env-user",
        metronPassword: "env-pass",
        ebayClientId: "env-id",
        ebayClientSecret: "env-secret",
        seedOnEmpty: "true",
      }),
    });
    await service.saveSecret("metron.password", "db-pass");
    await service.setSeedOnEmpty(false);
    const saved = await service.get();
    expect(saved.metron.username).toBe("env-user");
    expect(saved.metron.password).toBe("db-pass");
    expect(saved.metron.passwordSource).toBe("database");
    expect(saved.seedOnEmpty).toEqual({ enabled: false, source: "database" });
    expect(saved.ebay.configured).toBe(true);

    const view = await service.view();
    expect(JSON.stringify(view)).not.toContain("db-pass");
    expect(JSON.stringify(view)).not.toContain("env-pass");
    expect(JSON.stringify(view)).not.toContain("env-secret");
    expect(view.metron.password).toEqual({ source: "database", mask: SECRET_MASK });
    expect(view.metron.username).toEqual({ source: "environment", mask: SECRET_MASK });

    await service.clearSecret("metron.password");
    const cleared = await service.get();
    expect(cleared.metron.password).toBe("env-pass");
    expect(cleared.metron.passwordSource).toBe("environment");
    expect(repo.rows.some((row) => row.secret?.includes("db-pass"))).toBe(false);
  });

  it("stores secrets as ciphertext", async () => {
    const repo = memoryRepo();
    const service = createSettingsService({ repo, key, env: env() });
    await service.saveSecret("comicvine.apiKey", "cv-live-key");
    const row = repo.rows.find((item) => item.key === "comicvine.apiKey");
    expect(row?.secret?.startsWith("v1.")).toBe(true);
    expect(row?.secret).not.toContain("cv-live-key");
    expect((await service.get()).comicvine.apiKey).toBe("cv-live-key");
  });

  it("prefers basic auth when username and password are set", () => {
    const config = buildConfig(emptyStored(), env({ metronUsername: "cody", metronPassword: "secret", metronToken: "token-value" }));
    const auth = metronAuthorization(config);
    expect(auth?.header.startsWith("Basic ")).toBe(true);
    expect(auth?.header).not.toContain("token-value");
  });

  it("seeds only when the toggle is on and the shelf is empty", () => {
    expect(shouldSeedShelf(true, 0)).toBe(true);
    expect(shouldSeedShelf(true, 30)).toBe(false);
    expect(shouldSeedShelf(false, 0)).toBe(false);
  });
});

describe("connection probes", () => {
  const secret = "super-secret-value";

  function config(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
    return {
      ...buildConfig(
        { secrets: { "metron.password": secret, "comicvine.apiKey": secret, "ebay.clientSecret": secret }, seedOnEmpty: null },
        env({ metronUsername: "cody", ebayClientId: "ebay-id" }),
      ),
      ...overrides,
    };
  }

  it("checks Metron with basic auth and does not return the password", async () => {
    const headers: Record<string, string>[] = [];
    const result = await probeMetron(config(), async (_url, init) => {
      headers.push(init?.headers as Record<string, string>);
      return new Response("{}", { status: 200 });
    });
    expect(result).toEqual({ ok: true, message: "Metron accepted the username and password." });
    expect(headers[0]?.Authorization.startsWith("Basic ")).toBe(true);
    expect(result.message).not.toContain(secret);
    const missing = await probeMetron(buildConfig(emptyStored(), env()), async () => {
      throw new Error("should not fetch");
    });
    expect(missing.ok).toBe(false);
  });

  it("checks Comic Vine without echoing the API key", async () => {
    let seen = "";
    const result = await probeComicVine(config(), async (url) => {
      seen = String(url);
      return Response.json({ status_code: 100 });
    });
    expect(seen).toContain("api_key=");
    expect(result).toEqual({ ok: false, message: "Comic Vine rejected the API key." });
    expect(result.message).not.toContain(secret);
  });

  it("checks eBay with the client credentials grant and does not return a token", async () => {
    const result = await probeEbay(config(), async () => Response.json({ access_token: "should-not-leak" }));
    expect(result).toEqual({ ok: true, message: "eBay accepted the client id and secret." });
    expect(result.message).not.toContain("should-not-leak");
    expect(result.message).not.toContain(secret);
    const throughStub = await testEbayConnection(config(), async () => new Response("", { status: 401 }));
    expect(throughStub.message).toBe("eBay rejected the client id or secret.");
  });
});
