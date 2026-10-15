import { prisma } from "@/lib/db";

export const FACSIMILE_YEAR_KEY = "facsimile-catalog-years";
/** Bumped so a deploy that understands later printings runs the one-time pass again. */
export const FACSIMILE_REMATCH_KEY = "edition-rematch-v2";
export const PRINTING_COVER_KEY = "printing-covers";

export async function readCatalogYears(): Promise<Record<string, number>> {
  const row = await prisma.appSetting.findUnique({ where: { key: FACSIMILE_YEAR_KEY } });
  if (!row?.plain) return {};
  try {
    const parsed = JSON.parse(row.plain) as Record<string, unknown>;
    const years: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isInteger(value) && value > 1800 && value < 2200) years[id] = value;
    }
    return years;
  } catch {
    return {};
  }
}

export async function writeCatalogYear(comicId: string, year: number | null): Promise<void> {
  const years = await readCatalogYears();
  if (year == null) delete years[comicId];
  else years[comicId] = year;
  await prisma.appSetting.upsert({
    where: { key: FACSIMILE_YEAR_KEY },
    create: { key: FACSIMILE_YEAR_KEY, plain: JSON.stringify(years), secret: null },
    update: { plain: JSON.stringify(years), secret: null },
  });
}

export async function readPrintingCovers(): Promise<Record<string, number>> {
  const row = await prisma.appSetting.findUnique({ where: { key: PRINTING_COVER_KEY } });
  if (!row?.plain) return {};
  try {
    const parsed = JSON.parse(row.plain) as Record<string, unknown>;
    const covers: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 20) covers[id] = value;
    }
    return covers;
  } catch {
    return {};
  }
}

export async function writePrintingCover(comicId: string, printing: number | null): Promise<void> {
  const covers = await readPrintingCovers();
  if (printing == null || printing < 2) delete covers[comicId];
  else covers[comicId] = printing;
  await prisma.appSetting.upsert({
    where: { key: PRINTING_COVER_KEY },
    create: { key: PRINTING_COVER_KEY, plain: JSON.stringify(covers), secret: null },
    update: { plain: JSON.stringify(covers), secret: null },
  });
}
