"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { linkMatchAction, loadGcdMatchAction, loadMatchCoversAction, repullCoverAction, searchMatchesAction, unlinkMatchAction } from "@/app/issues/actions";
import { queueSearchAction } from "@/app/logs/queue-actions";
import { CatalogIdLink, LinkedMessage } from "@/components/catalog-id-link";
import { LimitToast } from "@/components/limit-toast";
import { matchPanelNote } from "@/lib/catalog/limit-notice";
import type { QueueHint, QueueRequest } from "@/lib/catalog/search-queue";
import type { MatchCover, MatchHit } from "@/lib/catalog/match-hits";
import { catalogIssueHref, catalogViewLabel, defaultUseCover, exactBarcodeMatch, fullSizeCoverUrl, GCD_COVER_NOTE, isGcdScanHost } from "@/lib/catalog/match-row";
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
  /** True when the shelf cover is a photo Cody uploaded. An automatic catalog cover stays false. */
  userCover: boolean;
};

export function MatchPanel(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [offer, setOffer] = useState<QueueRequest | null>(null);
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message: string; notice?: string | null }>) {
    start(async () => {
      const result = await action();
      setOk(result.ok);
      setMessage(result.notice ?? result.message);
      setToast(result.notice ?? "");
      setOffer(null);
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
          onNotice={(message, next) => {
            setToast(message);
            setOffer(message ? next : null);
          }}
          onLinked={(text, notice) => {
            setOk(true);
            setMessage(notice ?? text);
            setToast(notice ?? "");
            setOffer(null);
            router.refresh();
          }}
        />
      ) : null}
      <LimitToast
        message={toast}
        onDismiss={() => {
          setToast("");
          setOffer(null);
        }}
        onQueue={
          offer
            ? async () => {
                const result = await queueSearchAction(offer);
                if (result.ok) setOffer(null);
                setToast(result.message);
                return result.message;
              }
            : undefined
        }
      />
    </section>
  );
}

function MatchSheet(props: Props & { onClose: () => void; onNotice: (message: string, offer: QueueRequest | null) => void; onLinked: (message: string, notice: string | null) => void }) {
  const [source, setSource] = useState<CatalogSource>("metron");
  const [query, setQuery] = useState(props.query);
  const [barcode, setBarcode] = useState(props.barcode);
  const [hits, setHits] = useState<MatchHit[]>([]);
  const [selected, setSelected] = useState<MatchHit | null>(null);
  const [covers, setCovers] = useState<MatchCover[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [useCover, setUseCover] = useState(!props.userCover);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [fillMissing, setFillMissing] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [gcdRef, setGcdRef] = useState("");
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
  const visibleCovers = covers.filter((cover) => !isGcdScanHost(cover.imageUrl));

  function selectSource(next: CatalogSource) {
    setSource(next);
    setHits([]);
    setSelected(null);
    setError("");
    setNote(next === "metron" && metronMissed && followGcd ? metronEmptyNote : "");
  }

  function queued(queue: QueueHint | null | undefined, extra: Partial<QueueRequest> = {}): QueueRequest | null {
    if (!queue) return null;
    return {
      comicId: props.comicId,
      source: queue.source,
      kind: queue.kind,
      resumeAt: queue.resumeAt,
      query,
      barcode,
      shelfFormat: props.shelfFormat ?? null,
      shelfSeries: props.shelfSeries ?? null,
      facsimile: props.facsimile,
      ...extra,
    };
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
        comicId: props.comicId,
      });
      props.onNotice(result.notice ?? "", queued(result.queue, { mode }));
      if (!result.ok) {
        setHits([]);
        setError(result.notice ? "" : result.message);
        setNote(result.notice ?? "");
        return;
      }
      if (result.notice) {
        setHits(result.hits);
        setNote(matchPanelNote(result.hits.length, result.notice));
        const sources = new Set(result.hits.map((hit) => hit.source));
        const only = sources.size === 1 ? result.hits[0]?.source : null;
        if (only) setSource(only);
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
          comicId: props.comicId,
        });
        props.onNotice(gcd.notice ?? "", queued(gcd.queue, { mode }));
        if (!gcd.ok) {
          setError(gcd.notice ? "" : gcd.message);
          setNote(gcd.notice ?? "");
          return;
        }
        if (gcd.notice) {
          setHits(gcd.hits);
          setNote(matchPanelNote(gcd.hits.length, gcd.notice));
          if (gcd.hits[0]?.source) setSource(gcd.hits[0].source);
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

  function coverChoice(hit: MatchHit) {
    const hasImage = Boolean(hit.coverUrl && !isGcdScanHost(hit.coverUrl)) || hit.covers.some((cover) => !isGcdScanHost(cover.imageUrl));
    setUseCover(defaultUseCover(hit.source, hasImage, props.userCover));
    setReplaceExisting(false);
  }

  function choose(hit: MatchHit) {
    setSelected(hit);
    setCovers(hit.covers);
    setCoverUrl(hit.coverUrl);
    coverChoice(hit);
    start(async () => {
      const loaded = await loadMatchCoversAction(hit.source, hit.id);
      if (loaded.length > 0) {
        setCovers(loaded);
        setCoverUrl((current) => current && loaded.some((cover) => cover.imageUrl === current) ? current : loaded[0].imageUrl);
      }
    });
  }

  function loadGcd() {
    setError("");
    setNote("");
    setSelected(null);
    start(async () => {
      const result = await loadGcdMatchAction(gcdRef);
      props.onNotice(result.notice ?? "", queued(result.queue, { gcdRef, mode: "query" }));
      if (!result.ok) {
        setHits([]);
        setError(result.notice ? "" : result.message);
        setNote(result.notice ?? "");
        return;
      }
      setHits(result.hits);
      setSelected(null);
      setCovers([]);
      setCoverUrl(null);
      if (result.hits.length === 0) setNote(matchPanelNote(0, result.notice));
    });
  }

  function link() {
    if (!selected) return;
    setError("");
    start(async () => {
      const result = await linkMatchAction({
        comicId: props.comicId,
        source: selected.source,
        hit: selected,
        useCover,
        fillMissing,
        overwrite: source === "gcd" && overwrite,
        replaceExisting,
        coverImageUrl: useCover ? coverUrl : null,
      });
      props.onNotice(
        result.notice ?? "",
        queued(result.queue, {
          hit: selected,
          useCover,
          fillMissing,
          overwrite: source === "gcd" && overwrite,
          replaceExisting,
          coverImageUrl: useCover ? coverUrl : null,
        }),
      );
      if (!result.ok) {
        setError(result.notice ? "" : result.message);
        setNote(result.notice ?? "");
        return;
      }
      props.onLinked(result.message, result.notice);
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
          <p className="mt-3 text-sm text-mist">GCD data is CC BY-SA. Each row is one issue, including variants.</p>
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
        {source === "gcd" ? (
          <>
            <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist" htmlFor="gcd-ref">
              GCD ID or URL
            </label>
            <input
              id="gcd-ref"
              className="field mt-1"
              value={gcdRef}
              placeholder="2513854 or https://www.comics.org/issue/2513854/"
              disabled={pending}
              onChange={(event) => setGcdRef(event.target.value)}
            />
          </>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50" disabled={!ready || pending} onClick={() => search("query")}>
            {pending ? "Searching…" : "Search"}
          </button>
          <button type="button" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50" disabled={!ready || pending} onClick={() => search("barcode")}>
            Search barcode
          </button>
          {source === "gcd" ? (
            <button type="button" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50" disabled={pending} onClick={loadGcd}>
              {pending ? "Loading…" : "Load GCD issue"}
            </button>
          ) : null}
        </div>
        {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
        {note ? <p className="mt-3 text-sm text-mist">{note}</p> : null}
        <ul className="mt-3 flex flex-col gap-2">
          {hits.map((hit) => {
            const facts = gcdFactLine(hit);
            const picked = selected?.id === hit.id && selected.source === hit.source;
            const viewHref = catalogIssueHref(hit.source, hit.id);
            const exact = hit.source === "gcd" && exactBarcodeMatch(props.barcode, hit.barcode);
            return (
              <li key={`${hit.source}-${hit.id}`} className={`flex w-full gap-3 rounded-xl p-2 ring-1 ${picked ? "bg-panel2 ring-comic" : "bg-ink/30 ring-white/5"}`}>
                <CoverMark hit={hit} />
                <div className="min-w-0 flex-1">
                  <button type="button" className="w-full text-left" onClick={() => choose(hit)}>
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold text-paper">
                        {hit.series} {hit.issueNo ? `#${hit.issueNo}` : ""}
                      </span>
                      {exact ? <span className="shrink-0 rounded-full bg-comic px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink">Exact barcode</span> : null}
                    </span>
                    {hit.variant ? <span className="block truncate text-sm text-mist">{hit.variant}</span> : null}
                    <span className="block truncate text-xs text-mist">{[hit.coverDate, hit.publisher].filter(Boolean).join(" · ")}</span>
                    {facts ? <span className="block truncate text-xs text-mist">{facts}</span> : null}
                  </button>
                  {viewHref ? (
                    <a href={viewHref} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs font-semibold text-comic hover:underline">
                      {catalogViewLabel(hit.source)}
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {selected ? (
          <div className="mt-4 rounded-2xl bg-ink/30 p-3 ring-1 ring-white/5">
            <p className="text-sm text-paper">
              Link {selected.series} {selected.issueNo ? `#${selected.issueNo}` : ""} on {selected.source === "metron" ? "Metron" : selected.source === "gcd" ? "GCD" : "Comic Vine"}{" "}
              <CatalogIdLink kind={source === "metron" ? "metron-issue" : source === "gcd" ? "gcd-issue" : "comicvine-issue"} id={selected.id} />. The other catalogs stay as they are.
            </p>
            {visibleCovers.length > 1 ? (
              <div className="mt-3 flex gap-2 overflow-x-auto">
                {visibleCovers.map((cover) => (
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
            <label className="mt-3 flex items-center gap-2 text-sm text-paper">
              <input type="checkbox" checked={useCover} onChange={(event) => setUseCover(event.target.checked)} />
              Use this cover
            </label>
            {selected.source === "gcd" ? <p className="mt-1 text-sm text-mist">{GCD_COVER_NOTE}</p> : null}
            {props.userCover ? (
              <label className="mt-2 flex items-center gap-2 text-sm text-paper">
                <input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />
                Replace existing
              </label>
            ) : null}
            <label className="mt-2 flex items-center gap-2 text-sm text-paper">
              <input type="checkbox" checked={fillMissing} onChange={(event) => setFillMissing(event.target.checked)} />
              Fill missing details
            </label>
            {source === "gcd" ? (
              <label className="mt-2 flex items-center gap-2 text-sm text-paper">
                <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
                Overwrite existing
              </label>
            ) : null}
          </div>
        ) : null}
        <button type="button" className="mt-3 rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50" disabled={pending || !selected} onClick={link}>
          {pending ? "Linking…" : "Accept"}
        </button>
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

function gcdFactLine(hit: MatchHit): string {
  if (hit.source !== "gcd") return "";
  return [hit.barcode || hit.isbn, hit.onSaleDate, hit.price].filter(Boolean).join(" · ");
}

function CoverMark({ hit }: { hit: MatchHit }) {
  if (hit.source === "gcd" || isGcdScanHost(hit.coverUrl)) {
    return (
      <span
        aria-label="Cover on GCD"
        className="flex h-16 w-14 shrink-0 items-center justify-center rounded-md bg-panel2 px-1 text-center text-[9px] font-semibold uppercase leading-tight text-mist"
      >
        Cover on GCD
      </span>
    );
  }
  const full = fullSizeCoverUrl(hit.coverUrl);
  if (!full) return <Thumb src={null} alt="" />;
  return (
    <a href={full} target="_blank" rel="noopener noreferrer" aria-label="Open the full-size cover" className="shrink-0">
      <Thumb src={hit.coverUrl} alt="" />
    </a>
  );
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src || isGcdScanHost(src)) {
    return <span aria-label="No cover" className="block h-16 w-11 rounded-md bg-panel2" />;
  }
  return (
    // Catalog thumbs are remote https images. Lazy so a long variant list does not fetch every scan at once.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" decoding="async" className="h-16 w-11 rounded-md object-cover" />
  );
}
