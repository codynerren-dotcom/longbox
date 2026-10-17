import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dockerignoreIncludes, forbiddenDockerContext, listDockerContext } from "@/lib/docker-context";
import { appCommit } from "@/lib/version";

const ignore = readFileSync(".dockerignore", "utf8");

describe("docker build context", () => {
  it("is an allowlist that leaves dumps and env files out", () => {
    expect(ignore).toMatch(/^\*$/m);
    const kept = [
      "package.json",
      "package-lock.json",
      "src/app/page.tsx",
      "src/app/covers/page.tsx",
      "public/sw.js",
      "docker/entrypoint.sh",
      "scripts/covers-propose.ts",
      "fixtures/clz-synthetic.csv",
      "prisma/schema.prisma",
      "prisma/seed.ts",
      "prisma/migrations/20261017140000_comic_isbn/migration.sql",
      "next.config.ts",
      "tsconfig.json",
      "REVISION",
    ];
    const dropped = [
      "backup-2026.sql",
      "notes.sql",
      "src/leak.sql",
      ".env",
      ".env.local",
      ".env.pre-deploy",
      ".env.example",
      "linksnap-shelf.csv",
      "backups/dump.sql",
      "data/covers/a.jpg",
      "covers/a.jpg",
      "node_modules/next/package.json",
      ".next/server/app.js",
      "AGENTS.md",
      "tests/docker-context.test.ts",
    ];
    for (const file of kept) expect(dockerignoreIncludes(ignore, file), file).toBe(true);
    for (const file of dropped) expect(dockerignoreIncludes(ignore, file), file).toBe(false);
    for (const file of [...kept, ...dropped]) {
      if (dockerignoreIncludes(ignore, file)) expect(forbiddenDockerContext(file), file).toBe(false);
    }
  });

  it("fails when the files on disk would be sent", () => {
    const sent = listDockerContext(".", ignore);
    const banned = sent.filter(forbiddenDockerContext);
    expect(banned).toEqual([]);
    expect(sent.some((file) => file === "node_modules" || file.startsWith("node_modules/") || file.startsWith(".next/") || file.startsWith("data/") || file.startsWith("backups/"))).toBe(false);
    expect(sent).toContain("src/app/covers/page.tsx");
    expect(sent).toContain("prisma/migrations/20261017140000_comic_isbn/migration.sql");
  });

  it("reports the image revision when LONGBOX_COMMIT is still the default", () => {
    const previous = process.env.LONGBOX_COMMIT;
    process.env.LONGBOX_COMMIT = "dev";
    writeFileSync("REVISION", "abc1234\n");
    try {
      expect(dockerignoreIncludes(ignore, "REVISION")).toBe(true);
      expect(readFileSync("docker/entrypoint.sh", "utf8")).toContain("/app/REVISION");
      expect(appCommit()).toBe("abc1234");
    } finally {
      unlinkSync("REVISION");
      if (previous === undefined) delete process.env.LONGBOX_COMMIT;
      else process.env.LONGBOX_COMMIT = previous;
    }
  });
});
