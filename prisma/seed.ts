import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseClzCsv } from "../src/lib/clz/parse";
import { persistClzComics } from "../src/lib/clz/persist";
import { prisma } from "../src/lib/db";

async function main() {
  const count = await prisma.comic.count();
  if (count > 0) {
    console.log(`Database already has ${count} comics. Skipping seed.`);
    return;
  }

  const file = path.join(process.cwd(), "fixtures/clz-synthetic.csv");
  const parsed = parseClzCsv(readFileSync(file, "utf8"));
  const summary = await persistClzComics(parsed.comics);
  await prisma.wishlistItem.createMany({
    data: [
      { series: "Saga", publisher: "Image", issueNo: "4", notes: "Gap in the run" },
      { series: "The Walking Dead", publisher: "Image", issueNo: "4", notes: "Gap in the run" },
    ],
  });
  console.log(JSON.stringify(summary));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
