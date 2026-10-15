import { readFieldSources } from "@/lib/covers/enrich";
import { prisma } from "@/lib/db";
import { writeLog } from "@/lib/log/write";
import { detectShelfFormat, shelfFormatOf } from "@/lib/shelf-format";

export const SHELF_FORMAT_KEY = "shelf-format-v1";

let inflight: Promise<void> | null = null;
let finishedForProcess = false;

/** One local pass that marks collected editions already on the shelf. */
export function scheduleShelfFormatBackfill(): void {
  if (process.env.VITEST || process.env.NEXT_PHASE === "phase-production-build") return;
  if (finishedForProcess || inflight) return;
  inflight = ensureShelfFormats()
    .then(() => {
      finishedForProcess = true;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Format backfill failed.";
      return writeLog({ level: "error", source: "system", message });
    })
    .finally(() => {
      inflight = null;
    });
}

export async function ensureShelfFormats(): Promise<number> {
  const flag = await prisma.appSetting.findUnique({ where: { key: SHELF_FORMAT_KEY } });
  if (flag?.plain === "done") return 0;
  const rows = await prisma.comic.findMany({
    select: {
      id: true,
      series: true,
      issue: true,
      issueNo: true,
      format: true,
      title: true,
      fullTitle: true,
      barcode: true,
      shelfFormat: true,
      fieldSources: true,
    },
  });
  let marked = 0;
  for (const row of rows) {
    if (readFieldSources(row.fieldSources).shelfFormat === "user") continue;
    const next = detectShelfFormat(row);
    if (next === shelfFormatOf(row.shelfFormat)) continue;
    await prisma.comic.update({ where: { id: row.id }, data: { shelfFormat: next } });
    marked += 1;
  }
  await prisma.appSetting.upsert({
    where: { key: SHELF_FORMAT_KEY },
    create: { key: SHELF_FORMAT_KEY, plain: "done", secret: null },
    update: { plain: "done" },
  });
  await writeLog({
    level: "info",
    source: "system",
    message: marked > 0 ? `Marked ${marked} collected editions from series names and CLZ format.` : "Shelf formats already match the collection.",
    details: { marked },
  });
  return marked;
}
