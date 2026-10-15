"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { previewCoverAction, revertCoverAction, uploadCoverAction } from "@/app/issues/actions";
import { portraitFrame, normalizeRotation } from "@/lib/covers/portrait";

const MAX_BYTES = 15 * 1024 * 1024;
const PREVIEW_EDGE = 1600;

type Placement = "overlay" | "menu" | "fields";

type Oriented = { url: string; width: number; height: number };

export function CoverControls({
  comicId,
  hasCover,
  canRevert,
  placement,
}: {
  comicId: string;
  hasCover: boolean;
  canRevert: boolean;
  placement: Placement;
}) {
  const router = useRouter();
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [oriented, setOriented] = useState<Oriented | null>(null);
  const [phase, setPhase] = useState<"idle" | "reading" | "saving">("idle");
  const busy = phase !== "idle";

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  useEffect(() => {
    if (!previewUrl) {
      setOriented(null);
      return;
    }
    let cancel = false;
    const img = new Image();
    img.onload = () => {
      if (cancel) return;
      setOriented(drawOriented(img, rotation));
    };
    img.onerror = () => {
      if (!cancel) setMessage("Could not read that photo.");
    };
    img.src = previewUrl;
    return () => {
      cancel = true;
    };
  }, [previewUrl, rotation]);

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function stopStream() {
    setStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
  }

  function closeCrop() {
    setFile(null);
    setPreviewUrl(null);
    setOriented(null);
    setPhase("idle");
  }

  async function beginCrop(next: File) {
    setMenuOpen(false);
    setMessage("");
    if (next.size <= 0 || next.size > MAX_BYTES) {
      setMessage("That photo is empty or too large.");
      return;
    }
    const heic = await looksHeic(next);
    if (!heic && !(await looksRaster(next))) {
      setMessage("Upload a jpg, png, webp, or heic photo.");
      return;
    }
    setPhase("reading");
    try {
      let url: string;
      if (heic) {
        const body = new FormData();
        body.set("photo", next);
        const result = await previewCoverAction(body);
        if (!result.ok) {
          setMessage(result.message);
          setPhase("idle");
          return;
        }
        url = result.dataUrl;
      } else {
        url = URL.createObjectURL(next);
      }
      setFile(next);
      setPreviewUrl((current) => {
        if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
        return url;
      });
      setRotation(0);
      setZoom(1);
      setPanX(0);
      setPanY(0);
      setPhase("idle");
    } catch {
      setMessage("Could not read that photo.");
      setPhase("idle");
    }
  }

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    event.target.value = "";
    if (next) void beginCrop(next);
  }

  async function takePhoto() {
    setMessage("");
    setMenuOpen(false);
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (coarse || !navigator.mediaDevices?.getUserMedia) {
      cameraRef.current?.click();
      return;
    }
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      setStream(next);
    } catch {
      cameraRef.current?.click();
    }
  }

  function shoot() {
    const video = videoRef.current;
    if (!video || video.videoWidth < 2) {
      setMessage("The camera has no picture yet.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      stopStream();
      if (!blob) {
        setMessage("Could not read that photo.");
        return;
      }
      void beginCrop(new File([blob], "cover.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  }

  async function saveCrop() {
    if (!file || !oriented) return;
    const frame = portraitFrame(oriented.width, oriented.height, 0, panX, panY, zoom);
    const body = new FormData();
    body.set("photo", file);
    body.set("rotation", String(rotation));
    body.set("x", String(frame.x));
    body.set("y", String(frame.y));
    body.set("width", String(frame.width));
    body.set("height", String(frame.height));
    setPhase("saving");
    setMessage("");
    const result = await uploadCoverAction(comicId, body);
    setPhase("idle");
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    closeCrop();
    router.refresh();
  }

  async function revert() {
    setMenuOpen(false);
    setMessage("");
    setPhase("saving");
    const result = await revertCoverAction(comicId);
    setPhase("idle");
    setMessage(result.ok ? "" : result.message);
    if (result.ok) router.refresh();
  }

  function setPan(x: number, y: number) {
    setPanX(x);
    setPanY(y);
  }

  const buttons = (
    <CoverButtons
      placement={placement}
      busy={busy}
      canRevert={canRevert}
      onUpload={() => uploadRef.current?.click()}
      onPhoto={() => void takePhoto()}
      onRevert={() => void revert()}
    />
  );

  const inputs = (
    <>
      <input
        ref={uploadRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
        className="sr-only"
        tabIndex={-1}
        onChange={onFile}
      />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} onChange={onFile} />
    </>
  );

  const notice = message ? (
    <p role="alert" className="mt-2 text-sm text-red-200">
      {message}
    </p>
  ) : null;

  let body: ReactNode;
  if (placement === "overlay" && !hasCover) {
    body = (
      <>
        <div className="absolute inset-0 z-10 flex items-center p-3">
          <div className="flex w-full flex-col gap-2 rounded-xl bg-ink/80 p-3 ring-1 ring-white/15">
            {buttons}
            {inputs}
          </div>
        </div>
        {notice}
      </>
    );
  } else if (placement === "menu" && hasCover) {
    body = (
      <div className="relative mt-3">
        <button
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="inline-flex min-h-11 items-center rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper ring-1 ring-white/10"
        >
          Cover
        </button>
        {menuOpen ? (
          <div className="absolute z-20 mt-2 flex w-56 flex-col gap-2 rounded-xl bg-panel p-2 ring-1 ring-white/10">
            {buttons}
          </div>
        ) : null}
        {inputs}
        {notice}
      </div>
    );
  } else if (placement === "fields") {
    body = (
      <div className="rounded-2xl bg-panel p-4 ring-1 ring-white/5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">Cover</p>
        <div className="mt-2 flex flex-wrap gap-2">{buttons}</div>
        {inputs}
        {notice}
      </div>
    );
  } else {
    body = null;
  }

  return (
    <>
      {body}
      {stream ? (
        <Sheet label="Take photo">
          <video ref={videoRef} autoPlay playsInline muted className="aspect-[3/4] w-full bg-black object-cover" />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={shoot} className={buttonClass(true, "primary")}>
              Shutter
            </button>
            <button type="button" onClick={stopStream} className={buttonClass(false, "ghost")}>
              Cancel
            </button>
          </div>
        </Sheet>
      ) : null}
      {file && previewUrl ? (
        <Sheet label="Straighten the cover">
          <CropStage oriented={oriented} zoom={zoom} panX={panX} panY={panY} onPan={setPan} />
          <label className="mt-3 block text-sm text-mist">
            Zoom
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="mt-1 block w-full accent-comic"
            />
          </label>
          <p className="mt-2 text-sm text-mist">Drag the photo to move it. Rotate until the cover is upright.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => setRotation((value) => (value + 270) % 360)} className={buttonClass(false, "ghost")}>
              Rotate left
            </button>
            <button type="button" onClick={() => setRotation((value) => (value + 90) % 360)} className={buttonClass(false, "ghost")}>
              Rotate right
            </button>
            <button type="button" disabled={busy || !oriented} onClick={() => void saveCrop()} className={buttonClass(true, "primary")}>
              {phase === "saving" ? "Saving…" : "Use this crop"}
            </button>
            <button type="button" disabled={busy} onClick={closeCrop} className={buttonClass(false, "ghost")}>
              Cancel
            </button>
          </div>
          {phase === "reading" ? <p className="mt-2 text-sm text-mist">Reading photo…</p> : null}
        </Sheet>
      ) : null}
    </>
  );
}

function CoverButtons({
  placement,
  busy,
  canRevert,
  onUpload,
  onPhoto,
  onRevert,
}: {
  placement: Placement;
  busy: boolean;
  canRevert: boolean;
  onUpload: () => void;
  onPhoto: () => void;
  onRevert: () => void;
}) {
  const full = placement !== "fields";
  return (
    <>
      <button type="button" disabled={busy} onClick={onUpload} className={buttonClass(full, "primary")}>
        Upload cover
      </button>
      <button type="button" disabled={busy} onClick={onPhoto} className={buttonClass(full, placement === "overlay" ? "ink" : "ghost")}>
        Take photo
      </button>
      {canRevert ? (
        <button type="button" disabled={busy} onClick={onRevert} className={buttonClass(full, "ghost")}>
          Revert to Metron cover
        </button>
      ) : null}
    </>
  );
}

function buttonClass(full: boolean, tone: "primary" | "ghost" | "ink"): string {
  const width = full ? "w-full" : "";
  const color =
    tone === "primary" ? "bg-comic text-ink" : tone === "ink" ? "bg-ink text-paper ring-1 ring-white/20" : "bg-panel2 text-paper ring-1 ring-white/10";
  return `inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50 ${width} ${color}`;
}

function Sheet({ label, children }: { label: string; children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/80 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={label}>
      <div className="max-h-[100dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-panel p-4 ring-1 ring-white/10">
        <h2 className="font-display text-4xl tracking-wide">{label}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function CropStage({
  oriented,
  zoom,
  panX,
  panY,
  onPan,
}: {
  oriented: Oriented | null;
  zoom: number;
  panX: number;
  panY: number;
  onPan: (x: number, y: number) => void;
}) {
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
    cropW: number;
    cropH: number;
    rw: number;
    rh: number;
  } | null>(null);
  const frame = oriented ? portraitFrame(oriented.width, oriented.height, 0, panX, panY, zoom) : null;

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!oriented || !frame) return;
    drag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: frame.x * oriented.width,
      originY: frame.y * oriented.height,
      cropW: frame.width * oriented.width,
      cropH: frame.height * oriented.height,
      rw: oriented.width,
      rh: oriented.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    const box = event.currentTarget.getBoundingClientRect();
    if (!start || box.width < 1 || box.height < 1) return;
    const dx = ((event.clientX - start.pointerX) / box.width) * start.cropW;
    const dy = ((event.clientY - start.pointerY) / box.height) * start.cropH;
    const maxX = Math.max(0, start.rw - start.cropW);
    const maxY = Math.max(0, start.rh - start.cropH);
    const x = clamp(start.originX - dx, 0, maxX);
    const y = clamp(start.originY - dy, 0, maxY);
    onPan(maxX === 0 ? 0 : (x - maxX / 2) / (maxX / 2), maxY === 0 ? 0 : (y - maxY / 2) / (maxY / 2));
  }

  return (
    <div
      className="relative mx-auto aspect-[2/3] w-full max-w-xs touch-none overflow-hidden rounded-xl bg-ink"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      {oriented && frame ? (
        // The crop is a local preview. The saved file is produced on the server.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={oriented.url}
          alt=""
          draggable={false}
          className="absolute max-w-none"
          style={{
            left: `${(-frame.x / frame.width) * 100}%`,
            top: `${(-frame.y / frame.height) * 100}%`,
            width: `${(1 / frame.width) * 100}%`,
            height: `${(1 / frame.height) * 100}%`,
          }}
        />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-mist">Reading photo…</p>
      )}
    </div>
  );
}

function drawOriented(img: HTMLImageElement, rotation: number): Oriented {
  const angle = normalizeRotation(rotation);
  const quarter = angle === 90 || angle === 270;
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = quarter ? h : w;
  canvas.height = quarter ? w : h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { url: img.src, width: img.naturalWidth, height: img.naturalHeight };
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return { url: canvas.toDataURL("image/jpeg", 0.85), width: canvas.width, height: canvas.height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function looksHeic(file: File): Promise<boolean> {
  if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return ascii(head, 4, 8) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heif"].includes(ascii(head, 8, 12));
}

async function looksRaster(file: File): Promise<boolean> {
  if (/jpeg|jpg|png|webp/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true;
  return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i] ?? 0);
  return text;
}
