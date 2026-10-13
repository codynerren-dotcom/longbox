import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/db";

export const metadata = { title: "Storage boxes" };

export default async function BoxesPage() {
  const comics = await prisma.comic.findMany({
    select: { storageBox: true, quantity: true, series: true },
    orderBy: { storageBox: "asc" },
  });
  const boxes = new Map<string, { copies: number; series: Set<string> }>();
  for (const comic of comics) {
    const name = comic.storageBox?.trim() || "Unboxed";
    const current = boxes.get(name) ?? { copies: 0, series: new Set<string>() };
    current.copies += comic.quantity;
    current.series.add(comic.series);
    boxes.set(name, current);
  }
  const entries = [...boxes.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div>
      <PageHeader kicker="Where they live" title="Storage boxes" />
      {entries.length === 0 ? (
        <p className="text-mist">No boxes yet. The storage box column from a CLZ import shows up here.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {entries.map(([name, box]) => (
            <li key={name}>
              <Link href={`/boxes/${encodeURIComponent(name)}`} className="block rounded-2xl bg-panel p-4 ring-1 ring-white/5 hover:ring-comic/60">
                <h2 className="font-display text-4xl tracking-wide">{name}</h2>
                <p className="mt-1 text-sm text-mist">
                  {box.copies} copies · {box.series.size} series
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
