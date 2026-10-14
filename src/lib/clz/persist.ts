import type { Prisma } from "@prisma/client";
import { legacyZeroCoreKeys, planZeroIdCleanup, type LegacyZeroRow } from "@/lib/clz/legacy-zero";
import { prisma } from "@/lib/db";
import { mergeByDedupeKey, planImport, type NormalizedComic } from "@/lib/clz/parse";

function data(comic: NormalizedComic): Prisma.ComicUpdateInput {
  return {
    coreComicId: comic.coreComicId,
    coreSeriesId: comic.coreSeriesId,
    clzIndex: comic.clzIndex,
    series: comic.series,
    seriesSort: comic.seriesSort,
    issue: comic.issue,
    issueNo: comic.issueNo,
    issueSort: comic.issueSort,
    variantDescription: comic.variantDescription,
    variant: comic.variant,
    publisher: comic.publisher,
    releaseDate: comic.releaseDate,
    format: comic.format,
    addedDate: comic.addedDate,
    coverDate: comic.coverDate,
    barcode: comic.barcode,
    storyArc: comic.storyArc,
    grade: comic.grade,
    rawOrSlabbed: comic.rawOrSlabbed,
    keyLevel: comic.keyLevel,
    keyCategory: comic.keyCategory,
    keyReason: comic.keyReason,
    purchasePrice: comic.purchasePrice,
    priceSold: comic.priceSold,
    covrPriceValue: comic.covrPriceValue,
    coverPrice: comic.coverPrice,
    notes: comic.notes,
    quantity: comic.quantity,
    storageBox: comic.storageBox,
    age: comic.age,
    country: comic.country,
    crossover: comic.crossover,
    fullTitle: comic.fullTitle,
    genre: comic.genre,
    imprint: comic.imprint,
    language: comic.language,
    releaseYear: comic.releaseYear,
    seriesGroup: comic.seriesGroup,
    subtitle: comic.subtitle,
    title: comic.title,
    coverYear: comic.coverYear,
    pageCount: comic.pageCount,
    addedYear: comic.addedYear,
    bagBoardDate: comic.bagBoardDate,
    bagBoardYear: comic.bagBoardYear,
    collectionStatus: comic.collectionStatus,
    modifiedDate: comic.modifiedDate,
    myRating: comic.myRating,
    owner: comic.owner,
    plot: comic.plot,
    read: comic.read,
    readDate: comic.readDate,
    readYear: comic.readYear,
    tags: comic.tags,
    customLabel: comic.customLabel,
    graderNotes: comic.graderNotes,
    gradingCompany: comic.gradingCompany,
    labelType: comic.labelType,
    myValue: comic.myValue,
    pageQuality: comic.pageQuality,
    purchaseDate: comic.purchaseDate,
    purchaseStore: comic.purchaseStore,
    purchaseYear: comic.purchaseYear,
    signedBy: comic.signedBy,
    slabCertNumber: comic.slabCertNumber,
    soldDate: comic.soldDate,
    soldYear: comic.soldYear,
    value: comic.value,
    source: "clz",
    rawRow: comic.rawRow,
  };
}

export type ImportSummary = {
  rows: number;
  unique: number;
  collapsed: number;
  created: number;
  updated: number;
  /** Stale rows whose dedupe key was `core:0|...` from before Core ComicID 0 counted as missing. */
  retired: number;
};

const staleSelect = {
  id: true,
  dedupeKey: true,
  series: true,
  issueNo: true,
  variant: true,
  coverFile: true,
  coverUrl: true,
  coverStatus: true,
  metronIssueId: true,
  coverNote: true,
} as const;

export async function persistClzComics(comics: NormalizedComic[]): Promise<ImportSummary> {
  const merged = mergeByDedupeKey(comics);
  const legacyKeys = [...new Set(merged.flatMap((comic) => legacyZeroCoreKeys(comic)))];
  const stale: LegacyZeroRow[] =
    legacyKeys.length === 0
      ? []
      : await prisma.comic.findMany({ where: { dedupeKey: { in: legacyKeys } }, select: staleSelect });
  const occupied = await prisma.comic.findMany({
    where: { dedupeKey: { in: [...merged.map((comic) => comic.dedupeKey), ...legacyKeys] } },
    select: { dedupeKey: true },
  });
  const occupiedKeys = new Set(occupied.map((row) => row.dedupeKey));
  const cleanup = planZeroIdCleanup(merged, stale, occupiedKeys);
  for (const action of cleanup.retarget) {
    await prisma.comic.update({ where: { id: action.id }, data: { dedupeKey: action.dedupeKey } });
    occupiedKeys.delete(action.fromKey);
    occupiedKeys.add(action.dedupeKey);
  }
  const plan = planImport(occupiedKeys, merged);

  const chunkSize = 40;
  for (let index = 0; index < merged.length; index += chunkSize) {
    const chunk = merged.slice(index, index + chunkSize);
    await prisma.$transaction(
      chunk.map((comic) =>
        prisma.comic.upsert({
          where: { dedupeKey: comic.dedupeKey },
          create: { dedupeKey: comic.dedupeKey, ...data(comic) } as Prisma.ComicCreateInput,
          update: data(comic),
        }),
      ),
    );
  }

  for (const action of cleanup.remove) {
    if (action.cover && action.coverOntoKey) {
      const dest = await prisma.comic.findUnique({
        where: { dedupeKey: action.coverOntoKey },
        select: { id: true, coverFile: true },
      });
      if (dest && !dest.coverFile) {
        await prisma.comic.update({ where: { id: dest.id }, data: action.cover });
      }
    }
    await prisma.comic.delete({ where: { id: action.id } });
  }

  return {
    rows: comics.length,
    unique: merged.length,
    collapsed: comics.length - merged.length,
    created: plan.create,
    updated: plan.update,
    retired: cleanup.retarget.length + cleanup.remove.length,
  };
}
