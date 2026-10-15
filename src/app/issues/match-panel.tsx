"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { linkMatchAction, loadMatchCoversAction, repullCoverAction, searchMatchesAction, unlinkMatchAction } from "@/app/issues/actions";
import { CatalogIdLink, LinkedMessage } from "@/components/catalog-id-link";
import type { MatchCover, MatchHit } from "@/lib/catalog/match-hits";
import type { CatalogSource } from "@/lib/catalog/manual-link";
import { isCollected, shelfFormatOf } from "@/lib/shelf-format";

type Props = {
  comicId: string;
  query: string;
  barcode: string;
  facsimile?: boolean;
  shelfFormat?: string | null;
  shelfSeries?: string | null;
  metronReady: boolean;
  comicVineReady: boolean;
  metronIssueId: string | null;
  metronIssueUrl?: string | null;
  comicvineIssueId: string | null;
  gcdIssueId: string | null;
  canRepull: boolean;
};

export function MatchPanel(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    start(async () => {
      const result = await action();
      setOk(result.ok);
      setMessage(result.message);
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="mt-4 rounded-2xl bg-panel p-4 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-3xl tracking-wide">Match</h2>
        <button type="button" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink" onClick={() => setOpen(true)}>
          Match / Link
        </button>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">Metron</dt>
          <dd className="text-paper">{props.metronIssueId ? <CatalogIdLink kind="metron-issue" id={props.metronIssueId} siteUrl={props.metronIssueUrl} /> : "Not linked"}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">Comic Vine</dt>
          <dd className="text-paper">{props.comicvineIssueId ? <CatalogIdLink kind="comicvine-issue" id={props.comicvineIssueId} /> : "Not linked"}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">GCD</dt>
          <dd className="text-paper">{props.gcdIssueId ? <CatalogIdLink kind="gcd-issue" id={props.gcdIssueId} /> : "Not linked"}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {props.metronIssueId ? (
          <button type="button" disabled={pending} className="rounded-full bg-panel2 px-3 py-1.5 text-sm text-paper disabled:opacity-50" onClick={() => run(() => unlinkMatchAction(props.comicId, "metron"))}>
            Unlink Metron
          </button>
        ) : null}
        {props.comicvineIssueId ? (
          <button type="button" disabled={pending} className="rounded-full bg-panel2 px-3 py-1.5 text-sm text-paper disabled:opacity-50" onClick={() => run(() => unlinkMatchAction(props.comicId, "comicvine"))}>
            Unlink Comic Vine
          </button>
        ) : null}
        {props.gcdIssueId ? (
          <button type="button" disabled={pending} className="rounded-full bg-panel2 px-3 py-1.5 text-sm text-paper disabled:opacity-50" onClick={() => run(() => unlinkMatchAction(props.comicId, "gcd"))}>
            Unlink GCD
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending || !props.canRepull}
          title={props.canRepull ? "Download the linked cover again" : "Link an issue before re-pulling its cover."}
          className="rounded-full bg-panel2 px-3 py-1.5 text-sm text-paper disabled:opacity-50"
          onClick={() => run(() => repullCoverAction(props.comicId))}
        >
          Re-pull cover
        </button>
      </div>
      {message ? (
        <p className={ok ? "mt-2 text-sm text-paper" : "mt-2 text-sm text-red-300"}>
          <LinkedMessage text={message} />
        </p>
      ) : null}
      {open ? (
        <MatchSheet
          {...props}
          onClose={() => setOpen(false)}
          onLinked={(text) => {
            setOk(true);
            setMessage(text);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function MatchSheet(props: Props & { onClose: () => void; onLinked: (message: string) => void }) {
  const [source, setSource] = useState<CatalogSource>("metron");
  const [query, setQuery] = useState(props.query);
  const [barcode, setBarcode] = useState(props.barcode);
  const [hits, setHits] = useState<MatchHit[]>([]);
  const [selected, setSelected] = useState<MatchHit | null>(null);
  const [covers, setCovers] = useState<MatchCover[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [useCover, setUseCover] = useState(true);
  const [fillMissing, setFillMissing] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [metronMissed, setMetronMissed] = useState(false);
  const [pending, start] = useTransition();
  const ready = source === "metron" ? props.metronReady : source === "comicvine" ? props.comicVineReady : true;
  const hint = source === "metron" ? "Add a Metron username and password in Settings to search." : "Add a Comic Vine API key in Settings to search.";

  const collected = isCollected(shelfFormatOf(props.shelfFormat));
  const followGcd = props.facsimile || collected;
  const metronEmptyNote = props.facsimile
    ? "Metron may not list facsimiles, try GCD."
    : "Metron may not list this trade, try GCD.";

  function selectSource(next: CatalogSource) {
    setSource(next);
    setHits([]);
    setSelected(null);
    setError("");
    setNote(next === "metron" && metronMissed && followGcd ? metronEmptyNote : "");
  }

  function search(mode: "query" | "barcode") {
    setError("");
    setNote("");
    setSelected(null);
    start(async () => {
      const result = await searchMatchesAction({
        source,
        query,
        barcode,
        mode,
        shelfFormat: props.shelfFormat ?? null,
        shelfSeries: props.shelfSeries ?? null,
        facsimile: props.facsimile,
      });
      if (!result.ok) {
        setHits([]);
        setError(result.message);
        return;
      }
      if (source === "metron" && followGcd && result.hits.length === 0) {
        setMetronMissed(true);
        setHits([]);
        setNote(metronEmptyNote);
        const gcd = await searchMatchesAction({
          source: "gcd",
          query,
          barcode,
          mode,
          shelfFormat: props.shelfFormat ?? null,
          shelfSeries: props.shelfSeries ?? null,
          facsimile: props.facsimile,
        });
        if (!gcd.ok) {
          setError(gcd.message);
          return;
        }
        if (gcd.hits.length > 0) {
          setSource("gcd");
          setHits(gcd.hits);
          setNote("");
        }
        return;
      }
      setHits(result.hits);
      if (result.hits.length === 0) setNote("No matches.");
    });
  }

  function choose(hit: MatchHit) {
    setSelected(hit);
    setCovers(hit.covers);
    setCoverUrl(hit.coverUrl);
    setUseCover(Boolean(hit.coverUrl || hit.covers.length > 0));
    start(async () => {
      const loaded = await loadMatchCoversAction(hit.source, hit.id);
      if (loaded.length > 0) {
        setCovers(loaded);
        setCoverUrl((current) => current && loaded.some((cover) => cover.imageUrl === current) ? current : loaded[0].imageUrl);
      }
    });
  }

  function link() {
    if (!selected) return;
    setError("");
    start(async () => {
      const result = await linkMatchAction({
        comicId: props.comicId,
        source,
        hit: selected,
        useCover: source === "gcd" ? false : useCover,
        fillMissing,
        coverImageUrl: useCover ? coverUrl : null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      props.onLinked(result.message);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/75 md:items-center" role="dialog" aria-modal="true" aria-labelledby="match-title">
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-panel p-4 shadow-2xl ring-1 ring-white/10 md:max-w-2xl md:rounded-3xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="match-title" className="font-display text-4xl tracking-wide">Match / Link</h2>
          <button type="button" className="rounded-full bg-panel2 px-3 py-1 text-sm text-paper" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div className="mt-3 flex gap-2" role="tablist">
          <Tab active={source === "metron"} onClick={() => selectSource("metron")}>Metron</Tab>
          <Tab active={source === "comicvine"} onClick={() => selectSource("comicvine")}>Comic Vine</Tab>
          <Tab active={source === "gcd"} onClick={() => selectSource("gcd")}>GCD</Tab>
        </div>
        {source === "gcd" ? (
          <p className="mt-3 text-sm text-mist">GCD data is CC BY-SA. Cover scans stay on the GCD cover page, so this link does not download one.</p>
        ) : null}
        {ready ? null : (
          <p className="mt-3 text-sm text-mist">
            {hint}{" "}
            <Link href="/settings" className="text-comic">
              Open Settings
            </Link>
          </p>
        )}
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist" htmlFor="match-query">
          Query
        </label>
        <input id="match-query" className="field mt-1" value={query} disabled={!ready || pending} onChange={(event) => setQuery(event.target.value)} />
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist" htmlFor="match-barcode">
          Barcode
        </label>
        <input id="match-barcode" className="field mt-1" value={barcode} disabled={!ready || pending} onChange={(event) => setBarcode(event.target.value)} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50" disabled={!ready || pending} onClick={() => search("query")}>
            {pending ? "Searching…" : "Search"}
          </button>
          <button type="button" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50" disabled={!ready || pending} onClick={() => search("barcode")}>
            Search barcode
          </button>
        </div>
        {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
        {note ? <p className="mt-3 text-sm text-mist">{note}</p> : null}
        <ul className="mt-3 flex flex-col gap-2">
          {hits.map((hit) => (
            <li key={`${hit.source}-${hit.id}`}>
              <button type="button" className={`flex w-full gap-3 rounded-xl p-2 text-left ring-1 ${selected?.id === hit.id ? "bg-panel2 ring-comic" : "bg-ink/30 ring-white/5"}`} onClick={() => choose(hit)}>
                <Thumb src={hit.coverUrl} alt="" />
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-paper">
                    {hit.series} {hit.issueNo ? `#${hit.issueNo}` : ""}
                  </span>
                  {hit.variant ? <span className="block truncate text-sm text-mist">{hit.variant}</span> : null}
                  <span className="block truncate text-xs text-mist">{[hit.coverDate, hit.publisher].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <div className="mt-4 rounded-2xl bg-ink/30 p-3 ring-1 ring-white/5">
            <p className="text-sm text-paper">
              Link {selected.series} {selected.issueNo ? `#${selected.issueNo}` : ""} on {source === "metron" ? "Metron" : source === "gcd" ? "GCD" : "Comic Vine"}{" "}
              <CatalogIdLink kind={source === "metron" ? "metron-issue" : source === "gcd" ? "gcd-issue" : "comicvine-issue"} id={selected.id} />. The other catalogs stay as they are.
            </p>
            {covers.length > 1 ? (
              <div className="mt-3 flex gap-2 overflow-x-auto">
                {covers.map((cover) => (
                  <button
                    key={cover.imageUrl}
                    type="button"
                    className={`shrink-0 rounded-lg p-1 ring-2 ${coverUrl === cover.imageUrl ? "ring-comic" : "ring-transparent"}`}
                    aria-pressed={coverUrl === cover.imageUrl}
                    onClick={() => setCoverUrl(cover.imageUrl)}
                  >
                    <Thumb src={cover.imageUrl} alt={cover.label} />
                    <span className="mt-1 block max-w-16 truncate text-[10px] text-mist">{cover.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {source === "gcd" ? null : (
              <label className="mt-3 flex items-center gap-2 text-sm text-paper">
                <input type="checkbox" checked={useCover} onChange={(event) => setUseCover(event.target.checked)} />
                Use this cover
              </label>
            )}
            <label className="mt-2 flex items-center gap-2 text-sm text-paper">
              <input type="checkbox" checked={fillMissing} onChange={(event) => setFillMissing(event.target.checked)} />
              Fill missing details
            </label>
            <button type="button" className="mt-3 rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50" disabled={pending} onClick={link}>
              {pending ? "Linking…" : "Link this issue"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${active ? "bg-comic text-ink" : "bg-panel2 text-paper"}`} onClick={onClick}>
      {children}
    </button>
  );
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  return src ? (
    // Catalog thumbs are remote https images.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className="h-16 w-11 rounded-md object-cover" />
  ) : (
    <span className="block h-16 w-11 rounded-md bg-panel2" />
  );
}
