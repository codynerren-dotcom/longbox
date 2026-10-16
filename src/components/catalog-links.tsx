import { CatalogIdLink } from "@/components/catalog-id-link";
import { MetronCredit } from "@/components/metron-credit";
import { issueCatalogLinks, seriesCatalogLinks, type CatalogTarget } from "@/lib/catalog-links";

export function IssueCatalogLinks({
  comic,
}: {
  comic: {
    metronIssueId?: string | null;
    metronIssueUrl?: string | null;
    comicvineIssueId?: string | null;
    gcdIssueId?: string | null;
  };
}) {
  return <CatalogLinks links={issueCatalogLinks(comic)} />;
}

export function SeriesCatalogLinks({
  comics,
}: {
  comics: Array<{
    metronSeriesId?: string | null;
    metronSeriesUrl?: string | null;
    comicvineSeriesId?: string | null;
    gcdSeriesId?: string | null;
  }>;
}) {
  return <SeriesLinks links={seriesCatalogLinks(comics)} />;
}

function CatalogLinks({ links }: { links: CatalogTarget }) {
  if (!links.metron && !links.comicVine && !links.gcd && !links.gcdCover) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {links.metron ? <Outbound href={links.metron} label="View on Metron" /> : null}
      {links.comicVine ? <Outbound href={links.comicVine} label="View on ComicVine" /> : null}
      {links.gcd ? <Outbound href={links.gcd} label="View on GCD" /> : null}
      {links.gcdCover ? <Outbound href={links.gcdCover} label="GCD cover" /> : null}
    </div>
  );
}

function SeriesLinks({ links }: { links: CatalogTarget }) {
  if (!links.metron && !links.comicVine && !links.gcd && !links.gcdCover) return null;
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <SeriesChip label="Metron" view="View on Metron" href={links.metron} id={links.metronId} kind="metron-series" />
        <SeriesChip label="Comic Vine" view="View on ComicVine" href={links.comicVine} id={links.comicVineId} kind="comicvine-series" />
        <SeriesChip label="GCD" view="View on GCD" href={links.gcd} id={links.gcdId} kind="gcd-series" />
        {links.gcdCover ? <Outbound href={links.gcdCover} label="GCD cover" /> : null}
      </div>
      {links.metron ? <MetronCredit /> : null}
    </div>
  );
}

function SeriesChip({
  label,
  view,
  href,
  id,
  kind,
}: {
  label: string;
  view: string;
  href: string | null;
  id: string | null;
  kind: "metron-series" | "comicvine-series" | "gcd-series";
}) {
  if (!href) return null;
  if (!id) return <Outbound href={href} label={view} />;
  return (
    <span className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper">
      {label} <CatalogIdLink kind={kind} id={id} siteUrl={kind === "metron-series" ? href : null} />
    </span>
  );
}

function Outbound({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-comic">
      {label}
    </a>
  );
}
