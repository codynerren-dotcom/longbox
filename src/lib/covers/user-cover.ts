import { Prisma } from "@prisma/client";
import { manualLinkJson, readManualLink, withLinkedId, withUserCover } from "@/lib/catalog/manual-link";
import { coverPublicPath } from "@/lib/covers/backfill";
import { COVER_MAX_BYTES, backfillLockHeld, downloadCover, writeUserCoverFiles } from "@/lib/covers/files";
import { fetchMetronIssueRecord, metronBasicAuth, metronTransport } from "@/lib/covers/metron-client";
import { previewJpeg, readCrop, renderCover, sniffImage } from "@/lib/covers/photo";
import { prisma } from "@/lib/db";
import { logCoverReverted, logCoverUploaded } from "@/lib/log/events";
import { writeLog } from "@/lib/log/write";

function issueLabel(series: string, issueNo: string | null, issue: string | null): string {
  return `${series} #${issueNo || issue || "?"}`;
}

export async function saveUserCover(args: {
  comicId: string;
  bytes: Buffer;
  rotation: number;
  crop: ReturnType<typeof readCrop>;
}): Promise<void> {
  if (args.bytes.length === 0 || args.bytes.length > COVER_MAX_BYTES) throw new Error("That photo is empty or too large.");
  const comic = await prisma.comic.findUnique({
    where: { id: args.comicId },
    select: { id: true, series: true, issue: true, issueNo: true, manualLink: true },
  });
  if (!comic) throw new Error("This issue is no longer on the shelf.");
  const kind = sniffImage(args.bytes);
  if (!kind) throw new Error("Upload a jpg, png, webp, or heic photo.");
  const webp = await renderCover(args.bytes, args.rotation, args.crop);
  const stored = await writeUserCoverFiles({ comicId: comic.id, original: args.bytes, webp, ext: kind === "heif" ? "heif" : kind });
  await prisma.comic.update({
    where: { id: comic.id },
    data: {
      coverFile: stored.coverFile,
      coverUrl: `${coverPublicPath(stored.coverFile)}?v=${Date.now()}`,
      coverStatus: "manual",
      coverNote: null,
      coverCheckedAt: new Date(),
      manualLink: withUserCover(comic.manualLink, stored.originalFile),
    },
  });
  await logCoverUploaded(issueLabel(comic.series, comic.issueNo, comic.issue), comic.id);
}

export async function previewUserPhoto(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) throw new Error("That photo is empty or too large.");
  return previewJpeg(bytes);
}

export async function revertToMetronCover(comicId: string): Promise<{ ok: boolean; message: string }> {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true, series: true, issue: true, issueNo: true, metronIssueId: true, manualLink: true },
  });
  if (!comic) return { ok: false, message: "This issue is no longer on the shelf." };
  const link = readManualLink(comic.manualLink);
  const metronId = link.metronIssueId ?? (comic.metronIssueId && /^\d+$/.test(comic.metronIssueId) ? comic.metronIssueId : null);
  const label = issueLabel(comic.series, comic.issueNo, comic.issue);
  if (!metronId) return { ok: false, message: `${label} has no Metron cover to restore.` };
  if (backfillLockHeld()) return { ok: false, message: "A Metron run is already going. Wait for it to finish." };
  if (!(await metronBasicAuth())) return { ok: false, message: "Add a Metron username and password in Settings to restore the cover." };
  try {
    const detail = await fetchMetronIssueRecord(await metronTransport(), metronId);
    if (!detail?.imageUrl) return { ok: false, message: `Metron issue ${metronId} has no cover image.` };
    const filename = await downloadCover(detail.imageUrl, detail.id, undefined, { force: true });
    const next = withLinkedId(comic.manualLink, "metron", metronId, detail.imageUrl);
    await prisma.comic.update({
      where: { id: comic.id },
      data: {
        metronIssueId: metronId,
        coverFile: filename,
        coverUrl: coverPublicPath(filename),
        coverStatus: "matched",
        coverNote: null,
        coverCheckedAt: new Date(),
        manualLink: manualLinkJson(next) ?? Prisma.DbNull,
      },
    });
    await logCoverReverted(label, comic.id);
    return { ok: true, message: `Reverted ${label} to the Metron cover.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not restore the Metron cover.";
    await writeLog({ level: "error", source: "covers/backfill", message, details: { comicId } });
    return { ok: false, message };
  }
}
