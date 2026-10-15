"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { KeyBadge } from "@/components/key-badge";
import type { AddComicInput, CatalogMatch } from "@/lib/catalog/types";
import { SHELF_FORMAT_OPTIONS, detectShelfFormat, isCollected, isShelfFormat, volumeLabel } from "@/lib/shelf-format";
import { mergeDetectedCodes, parseComicBarcode } from "@/lib/barcode";

type Owned = {
  id: string;
  series: string;
  issueNo: string | null;
  publisher: string | null;
  grade: string | null;
  keyLevel: string | null;
  barcode: string | null;
  storageBox: string | null;
  variant: string | null;
};

type SheetState = {
  title: string;
  loading: boolean;
  owned: Owned | null;
  matches: CatalogMatch[];
  warnings: string[];
  error: string | null;
};

type QueueItem = AddComicInput & { label: string };

const QUEUE_KEY = "longbox.queue";

function loadQueue(): QueueItem[] {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueueItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function ScanClient({
  scanning,
  storageBox,
}: {
  scanning: { camera: "environment" | "user"; mode: "confirm" | "auto"; beep: boolean; vibrate: boolean };
  storageBox: string;
}) {
  const scanningRef = useRef(scanning);
  scanningRef.current = scanning;
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef<(code: string) => void>(() => {});
  const [camera, setCamera] = useState<"starting" | "scanning" | "denied" | "unsupported">("starting");
  const [engine, setEngine] = useState<string>("");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setQueue(loadQueue());
  }, []);

  useEffect(() => {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }, [queue]);

  function signalScan() {
    const prefs = scanningRef.current;
    if (prefs.beep) beep();
    if (prefs.vibrate && typeof navigator.vibrate === "function") navigator.vibrate(40);
  }

  async function openLookup(barcode: string) {
    signalScan();
    setSheet({ title: barcode, loading: true, owned: null, matches: [], warnings: [], error: null });
    try {
      const response = await fetch(`/api/lookup?barcode=${encodeURIComponent(barcode)}`);
      const body = (await response.json()) as {
        owned: Owned | null;
        matches: CatalogMatch[];
        warnings: string[];
      };
      const matches = body.matches ?? [];
      if (scanningRef.current.mode === "auto") {
        if (body.owned) {
          setSheet(null);
          setNotice(`Already on the shelf: ${body.owned.series} #${body.owned.issueNo ?? "?"}`);
          return;
        }
        const match = matches.find((item) => !item.ownedId);
        if (match) {
          setSheet(null);
          await addItems([matchItem(match)]);
          return;
        }
      }
      setSheet({
        title: barcode,
        loading: false,
        owned: body.owned,
        matches,
        warnings: body.warnings ?? [],
        error: null,
      });
    } catch {
      setSheet({ title: barcode, loading: false, owned: null, matches: [], warnings: [], error: "Lookup failed." });
    }
  }

  onCodeRef.current = (code: string) => {
    void openLookup(code);
  };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    let last = { code: "", at: 0 };
    let controls: { stop: () => void } | null = null;

    const accept = (code: string) => {
      const now = Date.now();
      if (last.code === code && now - last.at < 2500) return;
      last = { code, at: now };
      onCodeRef.current(code);
    };

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera("unsupported");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: scanning.camera } },
          audio: false,
        });
      } catch {
        setCamera("denied");
        return;
      }
      const video = videoRef.current;
      if (stopped || !video) return;
      video.srcObject = stream;
      await video.play();
      setCamera("scanning");

      if (window.BarcodeDetector) {
        setEngine("BarcodeDetector");
        const detector = new window.BarcodeDetector({ formats: ["upc_a", "upc_e", "ean_13", "ean_8"] });
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const parsed = mergeDetectedCodes(found.map((code) => code.rawValue));
            if (parsed) accept(parsed.combined);
          } catch {
            // A single frame can fail while the camera is still starting.
          }
          timer = window.setTimeout(() => void tick(), 400);
        };
        void tick();
        return;
      }

      setEngine("ZXing");
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
      ]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const extensions = (DecodeHintType as { ALLOWED_EAN_EXTENSIONS?: unknown }).ALLOWED_EAN_EXTENSIONS;
      if (extensions) hints.set(extensions, [2, 5]);
      const reader = new BrowserMultiFormatReader(hints);
      controls = await reader.decodeFromVideoElement(video, (result) => {
        if (!result) return;
        const parsed = parseComicBarcode(result.getText());
        if (parsed) accept(parsed.combined);
      });
    }

    void start();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scanning.camera]);

  function queueMatch(match: CatalogMatch) {
    const item = matchItem(match);
    setQueue((current) => {
      const key = `${item.series}|${item.issueNo}|${item.barcode ?? ""}|${item.externalId ?? ""}`;
      if (current.some((entry) => `${entry.series}|${entry.issueNo}|${entry.barcode ?? ""}|${entry.externalId ?? ""}` === key)) {
        return current;
      }
      return [...current, item];
    });
    setNotice(`Queued ${item.label}`);
  }

  async function addItems(items: QueueItem[]) {
    if (items.length === 0) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map(({ label: _label, ...item }) => item),
        }),
      });
      const body = (await response.json()) as { results?: Array<{ created: boolean }>; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not add those comics.");
      const created = (body.results ?? []).filter((result) => result.created).length;
      setNotice(created > 0 ? `Added ${created} to the shelf.` : "Already on the shelf.");
      setQueue((current) => current.filter((entry) => !items.includes(entry)));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add those comics.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="overflow-hidden rounded-3xl bg-panel ring-1 ring-white/5">
        <div className="relative aspect-[3/4] bg-ink sm:aspect-video">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-6 border-2 border-comic/80" />
          <p className="absolute bottom-3 left-3 right-3 rounded-full bg-ink/75 px-3 py-1 text-center text-xs text-paper">
            {camera === "scanning"
              ? `Reading UPC-A + 5-digit add-on via ${engine}`
              : camera === "denied"
                ? "Camera permission is blocked. Use the barcode field instead."
                : camera === "unsupported"
                  ? "This browser has no camera. Type the barcode."
                  : "Starting camera…"}
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <form
          className="space-y-3 rounded-2xl bg-panel p-4 ring-1 ring-white/5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const barcode = String(data.get("barcode") ?? "");
            void openLookup(barcode);
          }}
        >
          <h2 className="font-display text-3xl tracking-wide">Barcode</h2>
          <input name="barcode" inputMode="numeric" placeholder="17-digit UPC" className="field" aria-label="Barcode" />
          <button type="submit" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
            Look up
          </button>
        </form>

        <form
          className="space-y-3 rounded-2xl bg-panel p-4 ring-1 ring-white/5"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const q = String(data.get("q") ?? "");
            const issue = String(data.get("issue") ?? "");
            setSheet({ title: q, loading: true, owned: null, matches: [], warnings: [], error: null });
            try {
              const response = await fetch(`/api/search?q=${encodeURIComponent(q)}&issue=${encodeURIComponent(issue)}`);
              const body = (await response.json()) as { matches: CatalogMatch[]; warnings: string[] };
              setSheet({
                title: issue ? `${q} #${issue}` : q,
                loading: false,
                owned: null,
                matches: body.matches ?? [],
                warnings: body.warnings ?? [],
                error: null,
              });
            } catch {
              setSheet({ title: q, loading: false, owned: null, matches: [], warnings: [], error: "Search failed." });
            }
          }}
        >
          <h2 className="font-display text-3xl tracking-wide">Manual search</h2>
          <input name="q" placeholder="Series" className="field" aria-label="Series" required />
          <input name="issue" placeholder="Issue number" className="field" aria-label="Issue number" />
          <button type="submit" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold ring-1 ring-white/10">
            Search
          </button>
        </form>

        <div className="rounded-2xl bg-panel p-4 ring-1 ring-white/5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-3xl tracking-wide">Queue</h2>
          {storageBox ? <p className="text-xs text-mist">New copies go in {storageBox}.</p> : null}
            <span className="font-display text-3xl text-comic">{queue.length}</span>
          </div>
          <ul className="mt-2 space-y-1 text-sm text-mist">
            {queue.length === 0 ? <li>Scan a stack, then add them together.</li> : null}
            {queue.map((item) => (
              <li key={`${item.label}-${item.barcode ?? item.externalId}`}>{item.label}</li>
            ))}
          </ul>
          <button
            type="button"
            disabled={queue.length === 0 || saving}
            onClick={() => void addItems(queue)}
            className="mt-3 rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
          >
            {saving ? "Adding…" : `Add stack (${queue.length})`}
          </button>
          {notice ? <p className="mt-2 text-sm text-paper">{notice}</p> : null}
        </div>
      </section>

      {sheet ? (
        <div className="fixed inset-x-0 bottom-0 z-50 md:left-64" role="dialog" aria-label="Scan matches">
          <button type="button" className="absolute inset-0 -top-[100vh] bg-black/50" aria-label="Close matches" onClick={() => setSheet(null)} />
          <div className="relative max-h-[70vh] overflow-y-auto rounded-t-3xl bg-panel2 px-4 pb-28 pt-4 shadow-2xl md:pb-6">
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-white/20" />
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="font-display text-4xl tracking-wide">{sheet.title || "Matches"}</h2>
              <button type="button" onClick={() => setSheet(null)} className="text-sm text-mist">
                Close
              </button>
            </div>
            {sheet.loading ? <p className="text-sm text-mist">Looking up the local shelf, then Metron and the Grand Comics Database.</p> : null}
            {sheet.error ? <p className="text-sm text-red-300">{sheet.error}</p> : null}
            {sheet.owned ? (
              <div className="mb-3 rounded-2xl bg-comic px-4 py-3 text-ink">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-display text-3xl tracking-wide">You own this</p>
                  <KeyBadge level={sheet.owned.keyLevel} />
                </div>
                <p className="text-sm">
                  {sheet.owned.series} #{sheet.owned.issueNo} · {sheet.owned.publisher} · {sheet.owned.grade || "ungraded"}
                </p>
                <Link href={`/issues/${sheet.owned.id}`} className="mt-2 inline-block text-sm font-semibold underline">
                  Open the issue
                </Link>
              </div>
            ) : null}
            <ul className="space-y-3">
              {sheet.matches.map((match) => (
                <li key={`${match.source}-${match.externalId}`} className="rounded-2xl bg-panel p-3 ring-1 ring-white/5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-comic">{match.source}</p>
                  <p className="font-medium">
                    {match.series} #{match.issueNo}
                  </p>
                  <p className="text-sm text-mist">{match.publisher || match.title}</p>
                  <div className="mt-3 flex gap-2">
                    {match.ownedId ? (
                      <Link href={`/issues/${match.ownedId}`} className="rounded-full bg-comic px-3 py-1.5 text-sm font-semibold text-ink">
                        You own this
                      </Link>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() =>
                            void addItems([
                              {
                                label: `${match.series} #${match.issueNo}`,
                                series: match.series,
                                issueNo: match.issueNo,
                                publisher: match.publisher,
                                coverUrl: match.coverUrl,
                                coverDate: match.coverDate,
                                barcode: match.barcode,
                                plot: match.plot,
                                variant: match.variant,
                                source: match.source,
                                externalId: match.externalId,
                                coreSeriesId: match.coreSeriesId,
                              },
                            ])
                          }
                          className="rounded-full bg-comic px-3 py-1.5 text-sm font-semibold text-ink"
                        >
                          Add to collection
                        </button>
                        <button
                          type="button"
                          onClick={() => queueMatch(match)}
                          className="rounded-full bg-panel2 px-3 py-1.5 text-sm font-semibold ring-1 ring-white/10"
                        >
                          + Queue
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {!sheet.loading && !sheet.owned && sheet.matches.length === 0 ? (
              <ManualAdd
                barcode={parseComicBarcode(sheet.title)?.combined ?? ""}
                onAdd={(item) => void addItems([item])}
              />
            ) : null}
            {sheet.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs text-mist">
                {sheet.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function matchItem(match: CatalogMatch): QueueItem {
  const shelfFormat = detectShelfFormat({
    series: match.series,
    issue: match.issueNo,
    issueNo: match.issueNo,
    barcode: match.barcode,
  });
  const mark = isCollected(shelfFormat) ? volumeLabel(match.issueNo) : `#${match.issueNo}`;
  return {
    label: `${match.series} ${mark}`,
    series: match.series,
    issueNo: match.issueNo,
    publisher: match.publisher,
    coverUrl: match.coverUrl,
    coverDate: match.coverDate,
    barcode: match.barcode,
    plot: match.plot,
    variant: match.variant,
    source: match.source === "local" ? "manual" : match.source,
    externalId: match.externalId,
    coreSeriesId: match.coreSeriesId,
    shelfFormat,
  };
}

function beep() {
  try {
    const context = new AudioContext();
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + 0.08);
    osc.onended = () => void context.close();
  } catch {
    // A blocked tone still leaves the scan result on screen.
  }
}

function ManualAdd({ barcode, onAdd }: { barcode: string; onAdd: (item: QueueItem) => void }) {
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const series = String(data.get("series") ?? "");
        const issueNo = String(data.get("issueNo") ?? "");
        const chosen = String(data.get("shelfFormat") ?? "");
        const shelfFormat = isShelfFormat(chosen)
          ? chosen
          : detectShelfFormat({ series, issue: issueNo, issueNo, barcode });
        const mark = isCollected(shelfFormat) ? volumeLabel(issueNo) : `#${issueNo}`;
        onAdd({
          label: `${series} ${mark}`,
          series,
          issueNo,
          publisher: String(data.get("publisher") ?? ""),
          barcode: barcode || null,
          source: "manual",
          shelfFormat,
        });
      }}
    >
      <p className="text-sm text-mist">No catalog match. Add it by hand.</p>
      <input name="series" required placeholder="Series" className="field" />
      <input name="issueNo" required placeholder="Issue or Vol. 1" className="field" />
      <select name="shelfFormat" defaultValue={detectShelfFormat({ barcode })} className="field" aria-label="Format">
        {SHELF_FORMAT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <input name="publisher" placeholder="Publisher" className="field" />
      <button type="submit" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
        Add to collection
      </button>
    </form>
  );
}
