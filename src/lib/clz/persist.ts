import { Prisma } from "@prisma/client";
import { legacyZeroCoreKeys, planZeroIdCleanup, type LegacyZeroRow } from "@/lib/clz/legacy-zero";
import { protectMetronFields } from "@/lib/covers/enrich";
import { prisma } from "@/lib/db";
import { conflictMessage, holdUserEdits } from "@/lib/issue-edit";
import { mergeByDedupeKey, planImport, type NormalizedComic } from "@/lib/clz/parse";
import { writeLog } from "@/lib/log/write";

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
    shelfFormat: comic.shelfFormat,
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

function clzWrite(
  comic: NormalizedComic,
  current: object | null,
  fieldSources: unknown,
): { update: Prisma.ComicUpdateInput; conflicts: ReturnType<typeof holdUserEdits>["conflicts"] } {
  const held = holdUserEdits(data(comic) as Record<string, unknown>, current, fieldSources);
  const guarded = protectMetronFields(held.update, fieldSources);
  const update = guarded.update as Prisma.ComicUpdateInput;
  if (guarded.changedSources) {
    update.fieldSources = Object.keys(guarded.sources).length > 0 ? guarded.sources : Prisma.DbNull;
  }
  return { update, conflicts: held.conflicts };
}

export type ImportSummary = {
  rows: number;
  unique: number;
  collapsed: number;
  created: number;
  updated: number;
  /** Stale rows whose dedupe key was `core:0|...` from before Core ComicID 0 counted as missing. */
  retired: number;
  /** User-edited fields a re-import left alone. */
  conflicts: string[];
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

  const conflicts: string[] = [];
  const chunkSize = 40;
  for (let index = 0; index < merged.length; index += chunkSize) {
    const chunk = merged.slice(index, index + chunkSize);
    const stored = await prisma.comic.findMany({
      where: { dedupeKey: { in: chunk.map((comic) => comic.dedupeKey) } },
    });
    const byKey = new Map(stored.map((row) => [row.dedupeKey, row]));
    const writes = chunk.map((comic) => {
      const current = byKey.get(comic.dedupeKey) ?? null;
      const write = clzWrite(comic, current, current?.fieldSources ?? null);
      if (write.conflicts.length > 0) conflicts.push(conflictMessage(comic.series, comic.issueNo, write.conflicts));
      return write.update;
    });
    await prisma.$transaction(
      chunk.map((comic, chunkIndex) =>
        prisma.comic.upsert({
          where: { dedupeKey: comic.dedupeKey },
          create: { dedupeKey: comic.dedupeKey, ...data(comic) } as Prisma.ComicCreateInput,
          update: writes[chunkIndex],
        }),
      ),
    );
  }
  await logImportConflicts(conflicts);

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
    conflicts,
  };
}

async function logImportConflicts(conflicts: string[]): Promise<void> {
  const shown = conflicts.slice(0, 40);
  for (const message of shown) {
    await writeLog({ level: "warn", source: "import", message, details: { skipped: "user-edit" } });
  }
  if (conflicts.length > shown.length) {
    await writeLog({
      level: "warn",
      source: "import",
      message: `${conflicts.length - shown.length} more CLZ re-import skips were omitted.`,
      details: { conflictCount: conflicts.length },
    });
  }
}
