import { prisma } from "@/lib/db";
import { toPlain } from "@/lib/export";

export const dynamic = "force-dynamic";

export async function GET() {
  const comics = await prisma.comic.findMany({ orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }] });
  return new Response(JSON.stringify(toPlain(comics), null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="longbox.json"',
      "Cache-Control": "no-store",
    },
  });
}
