import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { copyGroupKey } from "@/lib/series-view";

export const shelfCopySelect = {
  id: true,
  series: true,
  issueNo: true,
  variant: true,
  variantDescription: true,
  quantity: true,
  grade: true,
  gradingCompany: true,
  rawOrSlabbed: true,
  slabCertNumber: true,
  labelType: true,
  pageQuality: true,
  storageBox: true,
  purchasePrice: true,
  purchaseDate: true,
  coreSeriesId: true,
} satisfies Prisma.ComicSelect;

export type ShelfCopy = Prisma.ComicGetPayload<{ select: typeof shelfCopySelect }>;

type CopyAnchor = {
  series: string;
  issueNo: string | null;
  variant: string | null;
  variantDescription: string | null;
  quantity: number;
  coreSeriesId?: string | null;
};

/** Other shelf rows of the same series, issue, and variant. Records stay separate. */
export async function copiesOf(comic: CopyAnchor): Promise<ShelfCopy[]> {
  const or: Prisma.ComicWhereInput[] = [{ series: { equals: comic.series, mode: "insensitive" } }];
  if (comic.coreSeriesId) or.push({ coreSeriesId: comic.coreSeriesId });
  const rows = await prisma.comic.findMany({
    where: { OR: or },
    select: shelfCopySelect,
  });
  const key = copyGroupKey(comic);
  return rows.filter((row) => copyGroupKey(row) === key).sort(byPurchase);
}

function byPurchase(a: ShelfCopy, b: ShelfCopy): number {
  const ad = a.purchaseDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bd = b.purchaseDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (ad !== bd) return ad - bd;
  return a.id.localeCompare(b.id);
}
