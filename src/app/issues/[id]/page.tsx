import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { CoverTile } from "@/components/cover-tile";
import { ReadToggle } from "@/components/read-toggle";
import { prisma } from "@/lib/db";
import { formatDate, formatIssue, formatMoney } from "@/lib/format";
import { seriesRouteId } from "@/lib/series";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const comic = await prisma.comic.findUnique({ where: { id }, select: { series: true, issueNo: true } });
  return { title: comic ? `${comic.series} ${formatIssue(comic.issueNo)}` : "Issue" };
}

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const comic = await prisma.comic.findUnique({ where: { id } });
  if (!comic) notFound();
  const readDateValue = comic.readDate ? comic.readDate.toISOString().slice(0, 10) : "";

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div>
        <CoverTile
          title={comic.series}
          issue={comic.issueNo}
          coverUrl={comic.coverUrl}
          keyLevel={comic.keyLevel}
          slab={comic.rawOrSlabbed === "Slabbed"}
          variant={comic.variant}
        />
        <p className="mt-3 text-sm text-mist">
          <Link href={`/series/${encodeURIComponent(seriesRouteId(comic))}`} className="text-comic">
            Back to {comic.series}
          </Link>
        </p>
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-comic">{comic.publisher ?? "Publisher unknown"}</p>
        <h1 className="font-display text-5xl tracking-wide sm:text-6xl">
          {comic.series} {formatIssue(comic.issueNo)}
        </h1>
        {comic.variantDescription || comic.variant ? (
          <p className="mt-1 text-mist">{comic.variantDescription || comic.variant}</p>
        ) : null}
        {comic.quantity > 1 ? <p className="mt-2 text-sm text-paper">{comic.quantity} copies</p> : null}

        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          <Fact label="Key category" value={comic.keyCategory} />
          <Fact label="Key reason" value={comic.keyReason} />
          <Fact label="Grade" value={comic.grade} />
          <Fact label="Raw or slab" value={comic.rawOrSlabbed} />
        </section>

        <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-3xl tracking-wide">Slab</h2>
            {comic.rawOrSlabbed === "Slabbed" ? (
              <span className="rounded bg-slab px-2 py-1 font-display text-xl tracking-wide text-ink">
                {[comic.gradingCompany, comic.grade, comic.labelType].filter(Boolean).join(" · ") || "Slabbed"}
              </span>
            ) : (
              <span className="text-sm text-mist">Raw copy</span>
            )}
          </div>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <Fact label="Grading company" value={comic.gradingCompany} />
            <Fact label="Certification number" value={comic.slabCertNumber} />
            <Fact label="Label type" value={comic.labelType} />
            <Fact label="Page quality" value={comic.pageQuality} />
            <Fact label="Grader notes" value={comic.graderNotes} />
          </dl>
        </section>

        <section className="mt-4 grid gap-3 sm:grid-cols-2">
          <Fact label="Signed by" value={comic.signedBy} />
          <Fact label="Storage box" value={comic.storageBox ? <Link href={`/boxes/${encodeURIComponent(comic.storageBox)}`} className="text-comic">{comic.storageBox}</Link> : null} />
          <Fact label="Purchase price" value={formatMoney(comic.purchasePrice)} />
          <Fact label="Purchase date" value={formatDate(comic.purchaseDate)} />
          <Fact label="Purchase store" value={comic.purchaseStore} />
          <Fact label="Cover date" value={comic.coverDate} />
          <Fact label="Barcode" value={comic.barcode} />
          <Fact label="Story arc" value={comic.storyArc} />
        </section>

        <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
          <h2 className="font-display text-3xl tracking-wide">Plot</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-paper/90">{comic.plot || "No plot on this copy."}</p>
        </section>

        <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
          <h2 className="font-display text-3xl tracking-wide">Read</h2>
          <p className="mt-1 text-sm text-mist">{comic.read ? `Read ${formatDate(comic.readDate)}` : "Unread"}</p>
          <div className="mt-3">
            <ReadToggle id={comic.id} read={comic.read} readDate={readDateValue} />
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-dashed border-comic/50 bg-panel px-4 py-5">
          <h2 className="font-display text-3xl tracking-wide text-comic">Value</h2>
          <p className="mt-1 text-sm text-paper">Pricing coming soon (eBay)</p>
        </section>

        {comic.notes ? (
          <section className="mt-4 rounded-2xl bg-panel2 p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-mist">Notes</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm">{comic.notes}</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-panel2 px-3 py-3 ring-1 ring-white/5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">{label}</div>
      <div className="mt-1 text-sm text-paper">{value || "—"}</div>
    </div>
  );
}
