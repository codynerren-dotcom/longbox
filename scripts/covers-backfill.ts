import "dotenv/config";
import { acquireBackfillLock, releaseBackfillLock } from "../src/lib/covers/files";
import { metronBasicAuth } from "../src/lib/covers/metron-client";
import { runCoverBackfill } from "../src/lib/covers/run";
import { prisma } from "../src/lib/db";

async function main() {
  if (!(await metronBasicAuth())) {
    console.error("Set Metron username and password in Settings or the environment before running covers:backfill.");
    process.exit(1);
  }
  if (!acquireBackfillLock()) {
    console.error("A cover backfill is already running.");
    process.exit(1);
  }
  try {
    const summary = await runCoverBackfill((line) => console.error(line));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    releaseBackfillLock();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  releaseBackfillLock();
  process.exitCode = 1;
});
