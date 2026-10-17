import { parseComicBarcode } from "@/lib/barcode";
import type { AddComicInput } from "@/lib/catalog/types";
import { findByBarcode, findByIsbn } from "@/lib/catalog/lookup";
import { issueNumberValue } from "@/lib/clz/parse";
import { readFieldSources } from "@/lib/covers/enrich";
import { prisma } from "@/lib/db";
import { issueLabel } from "@/lib/issue-fields";
import { logIssueEdited } from "@/lib/log/events";
import { seriesRouteId, slugify } from "@/lib/series";
import { getPreferences } from "@/lib/settings/service";
import { canonicalIsbn, detectShelfFormat, isCollected, isShelfFormat, volumeNumber } from "@/lib/shelf-format";
import { safeImageUrl } from "@/lib/url";

function addDedupeKey(input: AddComicInput, barcode: string | null): string {
  if (barcode) return `barcode:${barcode}`;
  if (input.externalId) return `${input.source}:${input.externalId}`;
  const variant = (input.variant ?? "").trim().toLowerCase();
  return `manual:${slugify(input.series)}|${input.issueNo}|${variant}|${slugify(input.publisher ?? "")}`;
}

export async function addComics(items: AddComicInput[], owner: string) {
  const results: Array<{ id: string; created: boolean; series: string; issueNo: string }> = [];
  const defaultBox = (await getPreferences()).collection.defaultStorageBox.trim();

  for (const item of items) {
    const series = item.series.trim();
    const issueNo = item.issueNo.trim();
    if (!series || !issueNo) continue;
    const barcode = item.barcode ? parseComicBarcode(item.barcode)?.combined ?? item.barcode.trim() : null;

    if (barcode) {
      const parsed = parseComicBarcode(barcode);
      const existing = parsed ? await findByBarcode(parsed) : await findByIsbn(barcode);
      if (existing) {
        results.push({ id: existing.id, created: false, series: existing.series, issueNo: existing.issueNo ?? issueNo });
        continue;
      }
    }

    const dedupeKey = addDedupeKey(item, barcode);
    const already = await prisma.comic.findUnique({
      where: { dedupeKey },
      select: { id: true, series: true, issueNo: true },
    });
    if (already) {
      results.push({
        id: already.id,
        created: false,
        series: already.series,
        issueNo: already.issueNo ?? issueNo,
      });
      continue;
    }

    const coreSeriesId =
      item.coreSeriesId ??
      seriesRouteId({ series, publisher: item.publisher ?? null, coreSeriesId: null });
    const shelfFormat = isShelfFormat(item.shelfFormat)
      ? item.shelfFormat
      : detectShelfFormat({ series, issue: issueNo, issueNo, barcode });
    const volume = volumeNumber(issueNo);
    const comic = await prisma.comic.create({
      data: {
        dedupeKey,
        series,
        seriesSort: series.toLowerCase(),
        issue: issueNo,
        issueNo,
        issueSort: issueNumberValue(issueNo) ?? (volume ? Number(volume) : null),
        publisher: item.publisher?.trim() || null,
        variant: item.variant?.trim() || null,
        variantDescription: item.variantDescription?.trim() || null,
        barcode,
        isbn: canonicalIsbn(barcode),
        coverUrl: safeImageUrl(item.coverUrl),
        coverDate: item.coverDate ?? null,
        plot: item.plot ?? null,
        coreSeriesId,
        quantity: 1,
        storageBox: defaultBox || null,
        keyLevel: "No",
        rawOrSlabbed: "Raw",
        collectionStatus: "Owned",
        format: isCollected(shelfFormat) ? null : "Comic",
        shelfFormat,
        fieldSources: isShelfFormat(item.shelfFormat) ? { shelfFormat: "user" } : undefined,
        owner,
        source: item.source,
        read: false,
        rawRow: {
          source: item.source,
          externalId: item.externalId ?? null,
          addedAt: new Date().toISOString(),
        },
      },
    });
    results.push({ id: comic.id, created: true, series: comic.series, issueNo: comic.issueNo ?? issueNo });
  }

  return results;
}

export async function setReadState(id: string, read: boolean, readDate?: string | null) {
  const comic = await prisma.comic.findUnique({
    where: { id },
    select: { series: true, issueNo: true, fieldSources: true },
  });
  if (!comic) throw new Error("This issue is no longer on the shelf.");
  const when = read ? (readDate ? new Date(`${readDate}T12:00:00Z`) : new Date()) : null;
  const sources = readFieldSources(comic.fieldSources);
  sources.read = "user";
  sources.readDate = "user";
  sources.readYear = "user";
  const updated = await prisma.comic.update({
    where: { id },
    data: {
      read,
      readDate: when,
      readYear: when ? when.getUTCFullYear() : null,
      fieldSources: sources,
    },
  });
  await logIssueEdited(issueLabel(comic.series, comic.issueNo), id, ["Read", "Read date", "Read year"]);
  return updated;
}

export async function addWishlistItems(
  items: Array<{ series: string; publisher?: string | null; issueNo: string; notes?: string | null }>,
) {
  const data = items
    .map((item) => ({
      series: item.series.trim(),
      publisher: item.publisher?.trim() ?? "",
      issueNo: item.issueNo.trim(),
      notes: item.notes ?? null,
    }))
    .filter((item) => item.series && item.issueNo);

  if (data.length === 0) return { count: 0 };
  return prisma.wishlistItem.createMany({ data, skipDuplicates: true });
}

export async function removeWishlistItem(id: string) {
  await prisma.wishlistItem.delete({ where: { id } });
}
