import { prisma } from "@/lib/db";
import { renderClzCsv } from "@/lib/export";

export const dynamic = "force-dynamic";

export async function GET() {
  const comics = await prisma.comic.findMany({ orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }] });
  const body = renderClzCsv(comics.map((comic) => ({ ...comic })));
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="longbox.csv"',
      "Cache-Control": "no-store",
    },
  });
}
