import { prisma } from "@/lib/db";

export const FACSIMILE_YEAR_KEY = "facsimile-catalog-years";
export const FACSIMILE_REMATCH_KEY = "facsimile-rematch-v1";

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
