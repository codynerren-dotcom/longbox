import "dotenv/config";
import { rematchAllSuspectCopies } from "../src/lib/covers/facsimile-rematch";
import { prisma } from "../src/lib/db";

async function main() {
  const summary = await rematchAllSuspectCopies({ mode: "propose" });
  console.log(summary.message);
  if (summary.notice) console.error(summary.notice);
  if (!summary.ok) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
