import Link from "next/link";
import { CoverTile } from "@/components/cover-tile";
import { FormatBadge } from "@/components/format-badge";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/db";
import { copyCountLabel, groupCopies, groupQuantity, issueBadge, variantLetter } from "@/lib/series-view";
import { one } from "@/lib/format";

export const metadata = { title: "Key issues" };

export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const level = one((await searchParams).level);
  const where =
    level === "Major" || level === "Minor"
      ? { keyLevel: level }
      : { keyLevel: { in: ["Major", "Minor"] } };
  const comics = await prisma.comic.findMany({
    where,
    orderBy: [{ keyLevel: "asc" }, { seriesSort: "asc" }, { issueSort: "asc" }],
  });
  const groups = groupCopies(comics);

  return (
    <div>
      <PageHeader kicker="The good stuff" title="Key issues">
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <FilterLink href="/keys" active={!level} label="All" />
            <FilterLink href="/keys?level=Major" active={level === "Major"} label="Major" />
            <FilterLink href="/keys?level=Minor" active={level === "Minor"} label="Minor" />
          </div>
          {comics.length > 0 ? <p className="text-sm text-mist">{copyCountLabel(comics)}</p> : null}
        </div>
      </PageHeader>
      {groups.length === 0 ? (
        <p className="text-mist">No key issues on the shelf.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {groups.map((copies) => {
            const comic = copies.find((copy) => copy.coverUrl) ?? copies[0];
            if (!comic) return null;
            const quantity = groupQuantity(copies);
            const keyLevel = copies.some((copy) => copy.keyLevel === "Major") ? "Major" : comic.keyLevel;
            const reason = copies.map((copy) => copy.keyReason || copy.keyCategory).find((text) => text?.trim()) || keyLevel;
            const letter = variantLetter(comic.variant, comic.variantDescription);
            const badge = issueBadge(comic.issueNo, letter, comic.shelfFormat);
            return (
              <li key={comic.id}>
                <CoverTile
                  href={`/issues/${comic.id}`}
                  title={comic.series}
                  issue={badge.replace(/^#/, "")}
                  coverUrl={comic.coverUrl}
                  keyLevel={keyLevel}
                  slab={copies.every((copy) => copy.rawOrSlabbed === "Slabbed")}
                  variant={comic.variant}
                  quantity={quantity}
                  shelfFormat={comic.shelfFormat}
                />
                <p className="mt-2 flex items-center gap-2 font-medium">
                  <Link href={`/issues/${comic.id}`} className="hover:text-comic">
                    {comic.series} {badge}
                  </Link>
                  <FormatBadge format={comic.shelfFormat} />
                </p>
                <p className="text-sm text-mist">{reason}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 text-sm font-semibold ${active ? "bg-comic text-ink" : "bg-panel2 text-paper ring-1 ring-white/10"}`}
    >
      {label}
    </Link>
  );
}
