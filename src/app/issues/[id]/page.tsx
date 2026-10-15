import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { CoverControls } from "@/app/issues/cover-controls";
import { IssueEditor } from "@/app/issues/edit-form";
import { MatchPanel } from "@/app/issues/match-panel";
import { RemoveCopyButton } from "@/app/issues/remove-copy";
import { CatalogIdLink } from "@/components/catalog-id-link";
import { IssueCatalogLinks } from "@/components/catalog-links";
import { CoverTile } from "@/components/cover-tile";
import { FormatBadge } from "@/components/format-badge";
import { ReadToggle } from "@/components/read-toggle";
import { matchQuery, readManualLink } from "@/lib/catalog/manual-link";
import { metronConfigured } from "@/lib/catalog/metron";
import { detectEdition } from "@/lib/covers/edition";
import { fieldCredit } from "@/lib/covers/enrich";
import { prisma } from "@/lib/db";
import { isEmptyDisplay, showSlabSection } from "@/lib/issue-view";
import { toIssueDraft } from "@/lib/issue-fields";
import { costBasis } from "@/lib/clz/parse";
import { formatDate, formatIssue, formatMoney, type DateDisplay } from "@/lib/format";
import { dateOptions } from "@/lib/settings/preferences";
import { getPreferences, getSettings } from "@/lib/settings/service";
import { seriesRouteId } from "@/lib/series";
import { copiesOf, type ShelfCopy } from "@/lib/shelf-copies";
import { groupQuantity } from "@/lib/series-view";
import { isCollected, shelfFormatOf, tradeSearchSeries, volumeLabel, volumeNumber } from "@/lib/shelf-format";
import { safeImageUrl } from "@/lib/url";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const comic = await prisma.comic.findUnique({ where: { id }, select: { series: true, issueNo: true, issue: true, shelfFormat: true } });
  return { title: comic ? `${comic.series}${issueHeading(comic)}` : "Issue" };
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
  const copies = await copiesOf(comic);
  const when = dateOptions(prefs);
  const money = prefs.pricing.currency;
  const readDateValue = comic.readDate ? comic.readDate.toISOString().slice(0, 10) : "";
  const sourced = (field: string) => fieldCredit(comic.fieldSources, field);
  const edition = detectEdition(comic);
  const matchYear = edition.reprint ? (comic.releaseYear ?? comic.coverYear ?? comic.seriesYear) : (comic.coverYear ?? comic.releaseYear ?? comic.seriesYear);
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
    fact("Metron issue", comic.metronIssueId ? <CatalogIdLink kind="metron-issue" id={comic.metronIssueId} siteUrl={comic.metronIssueUrl} /> : null, sourced("metronIssueId")),
    fact("Metron series", comic.metronSeriesId ? <CatalogIdLink kind="metron-series" id={comic.metronSeriesId} siteUrl={comic.metronSeriesUrl} /> : null, sourced("metronSeriesId")),
    fact("Comic Vine issue", comic.comicvineIssueId ? <CatalogIdLink kind="comicvine-issue" id={comic.comicvineIssueId} /> : null, sourced("comicvineIssueId")),
    fact("Comic Vine series", comic.comicvineSeriesId ? <CatalogIdLink kind="comicvine-series" id={comic.comicvineSeriesId} /> : null, sourced("comicvineSeriesId")),
    fact("GCD issue", comic.gcdIssueId ? <CatalogIdLink kind="gcd-issue" id={comic.gcdIssueId} /> : null),
    fact("GCD series", comic.gcdSeriesId ? <CatalogIdLink kind="gcd-series" id={comic.gcdSeriesId} /> : null),
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
          issue={isCollected(shelfFormatOf(comic.shelfFormat)) ? volumeLabel(comic.issueNo, comic.issue) : comic.issueNo}
          coverUrl={comic.coverUrl}
          keyLevel={comic.keyLevel}
          slab={comic.rawOrSlabbed === "Slabbed"}
          variant={comic.variant}
          shelfFormat={comic.shelfFormat}
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
        <h1 className="flex flex-wrap items-center gap-3 font-display text-5xl tracking-wide sm:text-6xl">
          <span>
            {comic.series}
            {issueHeading(comic)}
          </span>
          <FormatBadge format={comic.shelfFormat} className="font-sans" />
        </h1>
        {comic.variantDescription || comic.variant ? (
          <p className="mt-1 text-mist">{comic.variantDescription || comic.variant}</p>
        ) : null}
        {comic.collects ? <p className="mt-2 text-sm text-paper">Collects {comic.collects}</p> : null}
        {copies.length > 1 ? (
          <CopyList copies={copies} currentId={comic.id} currency={money} when={when} />
        ) : comic.quantity > 1 ? (
          <p className="mt-2 text-sm text-paper">{comic.quantity} copies</p>
        ) : null}
        <IssueCatalogLinks comic={comic} />
        <MatchPanel
          comicId={comic.id}
          shelfFormat={comic.shelfFormat}
          shelfSeries={comic.series}
          query={matchQuery({
            series: isCollected(shelfFormatOf(comic.shelfFormat))
              ? tradeSearchSeries(comic.series) || comic.series
              : edition.searchNames[0] || comic.series,
            issueNo: isCollected(shelfFormatOf(comic.shelfFormat))
              ? volumeNumber(comic.issueNo, comic.issue)
              : edition.kind === "facsimile" || edition.kind === "printing"
                ? edition.issueNo
                : comic.issueNo,
            year: matchYear,
          })}
          barcode={comic.barcode ?? ""}
          facsimile={edition.kind === "facsimile"}
          metronReady={metronReady}
          comicVineReady={Boolean(settings.comicvine.apiKey)}
          metronIssueId={comic.metronIssueId}
          metronIssueUrl={comic.metronIssueUrl}
          comicvineIssueId={comic.comicvineIssueId}
          gcdIssueId={comic.gcdIssueId}
          canRepull={Boolean(link.coverImageUrl || comic.metronIssueId || comic.comicvineIssueId)}
        />

        <div id="editor">
        <IssueEditor
          draft={toIssueDraft(comic)}
          metronIssueUrl={comic.metronIssueUrl}
          metronSeriesUrl={comic.metronSeriesUrl}
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
                {sourced("plot") ? <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-comic">{sourced("plot")}</span> : null}
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
    </div>
  );
}

function CopyList({
  copies,
  currentId,
  currency,
  when,
}: {
  copies: ShelfCopy[];
  currentId: string;
  currency: string;
  when: DateDisplay;
}) {
  return (
    <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
      <h2 className="font-display text-3xl tracking-wide">Copies</h2>
      <p className="mt-1 text-sm text-mist">{groupQuantity(copies)} copies. Each record stays separate.</p>
      <ul className="mt-3 flex flex-col gap-2">
        {copies.map((copy) => {
          const current = copy.id === currentId;
          const detail = copyDetail(copy, currency, when);
          return (
            <li key={copy.id} className={`rounded-xl px-3 py-3 ring-1 ${current ? "bg-ink/40 ring-comic/60" : "bg-panel2 ring-white/5"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-paper">
                    {detail.condition}
                    {copy.quantity > 1 ? <span className="ml-2 text-comic">×{copy.quantity}</span> : null}
                    {current ? <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-comic">This copy</span> : null}
                  </p>
                  {detail.slab ? <p className="mt-1 text-mist">{detail.slab}</p> : null}
                  <p className="mt-1 text-mist">
                    {copy.storageBox ? (
                      <Link href={`/boxes/${encodeURIComponent(copy.storageBox)}`} className="text-comic">
                        {copy.storageBox}
                      </Link>
                    ) : (
                      "No box"
                    )}
                    {" · "}
                    {detail.price}
                    {detail.basis ? ` · Cost ${detail.basis}` : ""}
                    {" · "}
                    {detail.date}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Link href={current ? "#editor" : `/issues/${copy.id}#editor`} className="text-sm font-semibold text-comic">
                    Edit
                  </Link>
                  <RemoveCopyButton id={copy.id} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function copyDetail(copy: ShelfCopy, currency: string, when: DateDisplay) {
  const grade = copy.grade?.trim() || "";
  const company = copy.gradingCompany?.trim() || "";
  const raw = copy.rawOrSlabbed?.trim() || "";
  const slabbed = /^slab/i.test(raw);
  const condition = slabbed ? [company || "Slab", grade].filter(Boolean).join(" ") : [raw, grade].filter(Boolean).join(" ") || "No grade";
  const slabBits = slabbed
    ? [copy.labelType?.trim(), copy.slabCertNumber?.trim() ? `Cert ${copy.slabCertNumber.trim()}` : "", copy.pageQuality?.trim()].filter(Boolean)
    : [];
  const price = copy.purchasePrice != null ? `${formatMoney(copy.purchasePrice, currency)} each` : "No price";
  const spent = costBasis(copy.purchasePrice, copy.quantity);
  const basis = copy.quantity > 1 && spent ? formatMoney(spent, currency) : null;
  const date = copy.purchaseDate ? formatDate(copy.purchaseDate, when) : "No date";
  return { condition, slab: slabBits.join(" · "), price, basis, date };
}

function issueHeading(comic: { issueNo: string | null; issue: string | null; shelfFormat: string | null }): string {
  if (isCollected(shelfFormatOf(comic.shelfFormat))) {
    const label = volumeLabel(comic.issueNo, comic.issue);
    return label === "Vol." ? "" : ` ${label}`;
  }
  return comic.issueNo ? ` ${formatIssue(comic.issueNo)}` : "";
}

function fact(label: string, value: ReactNode, credit?: string | null) {
  return { label, value, credit };
}

function Facts({ items }: { items: { label: string; value: ReactNode; credit?: string | null }[] }) {
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

function Fact({ label, value, credit }: { label: string; value: ReactNode; credit?: string | null }) {
  return (
    <div className="rounded-xl bg-panel2 px-3 py-3 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">{label}</div>
        {credit ? <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-comic">{credit}</span> : null}
      </div>
      <div className="mt-1 text-sm text-paper">{value}</div>
    </div>
  );
}
