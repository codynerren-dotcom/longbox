import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseClzCsv } from "../src/lib/clz/parse";
import { persistClzComics } from "../src/lib/clz/persist";
import { prisma } from "../src/lib/db";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run import:clz -- path/to/clz.csv");
    process.exit(1);
  }
  const text = readFileSync(path.resolve(file), "utf8");
  const parsed = parseClzCsv(text);
  const summary = await persistClzComics(parsed.comics);
  console.log(JSON.stringify({ ...summary, warnings: parsed.warnings }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
