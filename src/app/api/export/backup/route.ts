import { prisma } from "@/lib/db";
import { buildBackup } from "@/lib/export";

export const dynamic = "force-dynamic";

export async function GET() {
  const [comics, wishlist, priceSnapshots, settings, imports] = await Promise.all([
    prisma.comic.findMany(),
    prisma.wishlistItem.findMany(),
    prisma.priceSnapshot.findMany(),
    prisma.appSetting.findMany({ select: { key: true, secret: true, plain: true } }),
    prisma.importRun.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
  const body = JSON.stringify(buildBackup({ comics, wishlist, priceSnapshots, settings, imports }), null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="longbox-backup.json"',
      "Cache-Control": "no-store",
    },
  });
}
