import Link from "next/link";
import { CoverTile } from "@/components/cover-tile";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/db";
import { formatIssue } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return { title: decodeURIComponent(name) };
}

export default async function BoxPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const comics = await prisma.comic.findMany({
    where: name === "Unboxed" ? { OR: [{ storageBox: null }, { storageBox: "" }] } : { storageBox: name },
    orderBy: [{ seriesSort: "asc" }, { issueSort: "asc" }],
  });

  return (
    <div>
      <PageHeader kicker="Storage" title={name}>
        <Link href="/boxes" className="text-sm text-comic">
          All boxes
        </Link>
      </PageHeader>
      {comics.length === 0 ? (
        <p className="text-mist">This box is empty.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {comics.map((comic) => (
            <li key={comic.id}>
              <CoverTile
                href={`/issues/${comic.id}`}
                title={comic.series}
                issue={comic.issueNo}
                coverUrl={comic.coverUrl}
                keyLevel={comic.keyLevel}
                slab={comic.rawOrSlabbed === "Slabbed"}
                variant={comic.variant}
              />
              <p className="mt-2 text-sm">
                <Link href={`/issues/${comic.id}`} className="hover:text-comic">
                  {comic.series} {formatIssue(comic.issueNo)}
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
