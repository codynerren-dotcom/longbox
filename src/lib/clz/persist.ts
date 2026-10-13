import type { Prisma } from "@prisma/client";
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
};

export async function persistClzComics(comics: NormalizedComic[]): Promise<ImportSummary> {
  const merged = mergeByDedupeKey(comics);
  const existing = await prisma.comic.findMany({
    where: { dedupeKey: { in: merged.map((comic) => comic.dedupeKey) } },
    select: { dedupeKey: true },
  });
  const plan = planImport(new Set(existing.map((row) => row.dedupeKey)), merged);

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

  return {
    rows: comics.length,
    unique: merged.length,
    collapsed: comics.length - merged.length,
    created: plan.create,
    updated: plan.update,
  };
}
