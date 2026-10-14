import { issueCatalogLinks, seriesCatalogLinks, type CatalogTarget } from "@/lib/catalog-links";

export function IssueCatalogLinks({
  comic,
}: {
  comic: {
    metronIssueId?: string | null;
    metronIssueUrl?: string | null;
    comicvineIssueId?: string | null;
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
  }>;
}) {
  return <CatalogLinks links={seriesCatalogLinks(comics)} />;
}

function CatalogLinks({ links }: { links: CatalogTarget }) {
  if (!links.metron && !links.comicVine) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {links.metron ? <Outbound href={links.metron} label="View on Metron" /> : null}
      {links.comicVine ? <Outbound href={links.comicVine} label="View on ComicVine" /> : null}
    </div>
  );
}

function Outbound({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-comic">
      {label}
    </a>
  );
}
