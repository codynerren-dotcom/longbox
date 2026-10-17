import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertDatabaseUrl, DATABASE_URL_MISSING } from "@/lib/db-url";

describe("database URL", () => {
  it("fails fast when DATABASE_URL is missing and stays quiet for tests and the production build", () => {
    const env = (values: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...values });
    expect(() => assertDatabaseUrl(env({}))).toThrow(DATABASE_URL_MISSING);
    expect(() => assertDatabaseUrl(env({ DATABASE_URL: "   " }))).toThrow(DATABASE_URL_MISSING);
    expect(() => assertDatabaseUrl(env({ VITEST: "true" }))).not.toThrow();
    expect(() => assertDatabaseUrl(env({ NEXT_PHASE: "phase-production-build" }))).not.toThrow();
    expect(() => assertDatabaseUrl(env({ DATABASE_URL: "postgres://user:CHANGE_ME@db:5432/longbox" }))).not.toThrow();
  });

  it("keeps placeholders out of the image, compose, and the example", () => {
    const docker = readFileSync("Dockerfile", "utf8");
    const compose = readFileSync("docker-compose.yml", "utf8");
    const example = readFileSync(".env.example", "utf8");
    const entry = readFileSync("docker/entrypoint.sh", "utf8");
    expect(docker).not.toMatch(/ENV\s+DATABASE_URL/);
    expect(docker).not.toContain("longbox:longbox");
    expect(docker).toContain("postgres://user:CHANGE_ME@db:5432/longbox");
    expect(compose).not.toContain(":-longbox");
    expect(compose).not.toContain("longbox:longbox");
    expect(compose).toContain("${DATABASE_URL:?Set DATABASE_URL in .env}");
    expect(example).toContain("DATABASE_URL=postgres://user:CHANGE_ME@db:5432/longbox");
    expect(example).toContain("POSTGRES_PASSWORD=CHANGE_ME");
    expect(example).not.toContain("longbox:longbox");
    expect(example).toContain("LONGBOX_LOG=off");
    const missing = entry.indexOf(DATABASE_URL_MISSING);
    expect(missing).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(entry.indexOf("prisma migrate"));
  });
});
