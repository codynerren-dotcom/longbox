import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { CoverControls } from "@/app/issues/cover-controls";
import { IssueEditor } from "@/app/issues/edit-form";
import { MatchPanel } from "@/app/issues/match-panel";
import { IssueCatalogLinks } from "@/components/catalog-links";
import { CoverTile } from "@/components/cover-tile";
import { ReadToggle } from "@/components/read-toggle";
import { matchQuery, readManualLink } from "@/lib/catalog/manual-link";
import { metronConfigured } from "@/lib/catalog/metron";
import { fromMetron } from "@/lib/covers/enrich";
import { prisma } from "@/lib/db";
import { isEmptyDisplay, showSlabSection } from "@/lib/issue-view";
import { toIssueDraft } from "@/lib/issue-fields";
import { costBasis } from "@/lib/clz/parse";
import { formatDate, formatIssue, formatMoney } from "@/lib/format";
import { dateOptions } from "@/lib/settings/preferences";
import { getPreferences, getSettings } from "@/lib/settings/service";
import { seriesRouteId } from "@/lib/series";
import { safeImageUrl } from "@/lib/url";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const comic = await prisma.comic.findUnique({ where: { id }, select: { series: true, issueNo: true } });
  return { title: comic ? `${comic.series}${comic.issueNo ? ` ${formatIssue(comic.issueNo)}` : ""}` : "Issue" };
}

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [comic, prefs, metronReady, settings, boxRows] = await Promise.all([
    prisma.comic.findUnique({ where: { id } }),
    getPreferences(),
    metronConfigured(),
    getSettings(),
    prisma.comic.findMany({
      where: { storageBox: { not: null } },
      distinct: ["storageBox"],
      select: { storageBox: true },
      orderBy: { storageBox: "asc" },
    }),
  ]);
  if (!comic) notFound();
  const when = dateOptions(prefs);
  const money = prefs.pricing.currency;
  const readDateValue = comic.readDate ? comic.readDate.toISOString().slice(0, 10) : "";
  const sourced = (field: string) => fromMetron(comic.fieldSources, field);
  const spent = costBasis(comic.purchasePrice, comic.quantity);
  const boxes = boxRows.map((row) => row.storageBox).filter((name): name is string => Boolean(name));
  const link = readManualLink(comic.manualLink);
  const hasCover = Boolean(safeImageUrl(comic.coverUrl));
  const canRevert = Boolean(comic.metronIssueId || link.metronIssueId);
  const coverTools = <CoverControls comicId={comic.id} hasCover={hasCover} canRevert={canRevert} placement="fields" />;
  const detailFacts = [
    fact("Story title", comic.title, sourced("title")),
    fact("Release date", comic.releaseDate ? formatDate(comic.releaseDate, when) : null, sourced("releaseDate")),
    fact("Page count", comic.pageCount ? String(comic.pageCount) : null, sourced("pageCount")),
    fact("Cover price", comic.coverPrice != null ? formatMoney(comic.coverPrice, money) : null, sourced("coverPrice")),
    fact("Writer", comic.writer, sourced("writer")),
    fact("Artist", comic.artist, sourced("artist")),
    fact("Cover artist", comic.coverArtist, sourced("coverArtist")),
    fact("Characters", comic.characters, sourced("characters")),
    fact("Teams", comic.teams, sourced("teams")),
    fact("Imprint", comic.imprint, sourced("imprint")),
    fact("Series year", comic.seriesYear ? String(comic.seriesYear) : null, sourced("seriesYear")),
    fact("Series volume", comic.seriesVolume ? String(comic.seriesVolume) : null, sourced("seriesVolume")),
    fact("Metron issue", comic.metronIssueId, sourced("metronIssueId")),
    fact("Metron series", comic.metronSeriesId, sourced("metronSeriesId")),
  ].filter((item) => !isEmptyDisplay(item.value));
  const slabFacts = [
    fact("Grading company", comic.gradingCompany),
    fact("Certification number", comic.slabCertNumber),
    fact("Label type", comic.labelType),
    fact("Page quality", comic.pageQuality),
    fact("Grader notes", comic.graderNotes),
  ].filter((item) => !isEmptyDisplay(item.value));

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="relative">
        <CoverTile
          title={comic.series}
          issue={comic.issueNo}
          coverUrl={comic.coverUrl}
          keyLevel={comic.keyLevel}
          slab={comic.rawOrSlabbed === "Slabbed"}
          variant={comic.variant}
        />
        <CoverControls comicId={comic.id} hasCover={hasCover} canRevert={canRevert} placement={hasCover ? "menu" : "overlay"} />
        <p className="mt-3 text-sm text-mist">
          <Link href={`/series/${encodeURIComponent(seriesRouteId(comic))}`} className="text-comic">
            Back to {comic.series}
          </Link>
        </p>
      </div>
      <div>
        {comic.publisher ? (
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-comic">{comic.publisher}</p>
        ) : null}
        <h1 className="font-display text-5xl tracking-wide sm:text-6xl">
          {comic.series}
          {comic.issueNo ? ` ${formatIssue(comic.issueNo)}` : ""}
        </h1>
        {comic.variantDescription || comic.variant ? (
          <p className="mt-1 text-mist">{comic.variantDescription || comic.variant}</p>
        ) : null}
        {comic.quantity > 1 ? <p className="mt-2 text-sm text-paper">{comic.quantity} copies</p> : null}
        <IssueCatalogLinks comic={comic} />
        <MatchPanel
          comicId={comic.id}
          query={matchQuery({ series: comic.series, issueNo: comic.issueNo, year: comic.coverYear ?? comic.releaseYear ?? comic.seriesYear })}
          barcode={comic.barcode ?? ""}
          metronReady={metronReady}
          comicVineReady={Boolean(settings.comicvine.apiKey)}
          metronIssueId={comic.metronIssueId}
          comicvineIssueId={comic.comicvineIssueId}
          canRepull={Boolean(link.coverImageUrl || comic.metronIssueId || comic.comicvineIssueId)}
        />

        <IssueEditor
          draft={toIssueDraft(comic)}
          boxes={boxes}
          categories={prefs.collection.keyCategories}
          companies={prefs.collection.gradingCompanies}
          coverTools={coverTools}
        >
          <Facts
            items={[
              fact("Key category", comic.keyCategory),
              fact("Key reason", comic.keyReason),
              fact("Grade", comic.grade),
              fact("Raw or slab", comic.rawOrSlabbed),
            ]}
          />

          {showSlabSection(comic.rawOrSlabbed) ? (
            <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-3xl tracking-wide">Slab</h2>
                <span className="rounded bg-slab px-2 py-1 font-display text-xl tracking-wide text-ink">
                  {[comic.gradingCompany, comic.grade, comic.labelType].filter(Boolean).join(" · ") || "Slabbed"}
                </span>
              </div>
              {slabFacts.length > 0 ? (
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  {slabFacts.map((item) => (
                    <Fact key={item.label} {...item} />
                  ))}
                </dl>
              ) : null}
            </section>
          ) : null}

          <Facts
            items={[
              fact("Signed by", comic.signedBy),
              fact(
                "Storage box",
                comic.storageBox ? (
                  <Link href={`/boxes/${encodeURIComponent(comic.storageBox)}`} className="text-comic">
                    {comic.storageBox}
                  </Link>
                ) : null,
              ),
              fact("Purchase price", comic.purchasePrice != null ? `${formatMoney(comic.purchasePrice, money)} each` : null),
              fact("Cost basis", spent ? formatMoney(spent, money) : null),
              fact("Purchase date", comic.purchaseDate ? formatDate(comic.purchaseDate, when) : null),
              fact("Purchase store", comic.purchaseStore),
              fact("Cover date", comic.coverDate, sourced("coverDate")),
              fact("Barcode", comic.barcode, sourced("barcode")),
              fact("Story arc", comic.storyArc, sourced("storyArc")),
            ]}
          />

          {detailFacts.length > 0 ? (
            <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
              <h2 className="font-display text-3xl tracking-wide">Details</h2>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                {detailFacts.map((item) => (
                  <Fact key={item.label} {...item} />
                ))}
              </dl>
            </section>
          ) : null}

          {comic.plot?.trim() ? (
            <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-3xl tracking-wide">Plot</h2>
                {sourced("plot") ? <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-comic">from Metron</span> : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-paper/90">{comic.plot}</p>
            </section>
          ) : null}

          <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
            <h2 className="font-display text-3xl tracking-wide">Read</h2>
            <p className="mt-1 text-sm text-mist">{comic.read ? (comic.readDate ? `Read ${formatDate(comic.readDate, when)}` : "Read") : "Unread"}</p>
            <div className="mt-3">
              <ReadToggle id={comic.id} read={comic.read} readDate={readDateValue} />
            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-dashed border-comic/50 bg-panel px-4 py-5">
            <h2 className="font-display text-3xl tracking-wide text-comic">Value</h2>
            <p className="mt-1 text-sm text-paper">
              {prefs.pricing.enabled
                ? `eBay pricing is on in ${prefs.pricing.currency}. Keys refresh ${prefs.pricing.keyCadence}, other issues ${prefs.pricing.otherCadence}. Quotes are still empty.`
                : "eBay pricing is off."}
            </p>
          </section>

          {comic.notes?.trim() ? (
            <section className="mt-4 rounded-2xl bg-panel2 p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-mist">Notes</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm">{comic.notes}</p>
            </section>
          ) : null}
        </IssueEditor>
      </div>
    </div>
  );
}

function fact(label: string, value: ReactNode, fromMetron?: boolean) {
  return { label, value, fromMetron };
}

function Facts({ items }: { items: { label: string; value: ReactNode; fromMetron?: boolean }[] }) {
  const shown = items.filter((item) => !isEmptyDisplay(item.value));
  if (shown.length === 0) return null;
  return (
    <section className="mt-4 grid gap-3 sm:grid-cols-2">
      {shown.map((item) => (
        <Fact key={item.label} {...item} />
      ))}
    </section>
  );
}

function Fact({ label, value, fromMetron: metron }: { label: string; value: ReactNode; fromMetron?: boolean }) {
  return (
    <div className="rounded-xl bg-panel2 px-3 py-3 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">{label}</div>
        {metron ? <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-comic">from Metron</span> : null}
      </div>
      <div className="mt-1 text-sm text-paper">{value}</div>
    </div>
  );
}
