import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseClzCsv } from "../src/lib/clz/parse";
import { persistClzComics } from "../src/lib/clz/persist";
import { prisma } from "../src/lib/db";
import { recordImportRun } from "../src/lib/imports";
import { logImportFailed, logImportFinished, logImportStarted } from "../src/lib/log/events";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run import:clz -- path/to/clz.csv");
    process.exit(1);
  }
  const filename = path.basename(file);
  try {
    await logImportStarted(filename);
    const text = readFileSync(path.resolve(file), "utf8");
    const parsed = parseClzCsv(text);
    const summary = await persistClzComics(parsed.comics);
    await recordImportRun({ filename, source: "cli", summary });
    await logImportFinished(filename, summary, parsed.warnings);
    console.log(JSON.stringify({ ...summary, warnings: [...parsed.warnings, ...summary.conflicts] }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    await logImportFailed(filename, message);
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
