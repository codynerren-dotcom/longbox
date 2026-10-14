export type CropFractions = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const ASPECT = 2 / 3;

export function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  if (!Number.isFinite(value)) return 0;
  const turns = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  if (turns === 90 || turns === 180 || turns === 270) return turns;
  return 0;
}

/** Largest 2:3 window on the rotated photo. Zoom shrinks it. Pan slides it, and both stay inside the photo. */
export function portraitFrame(srcW: number, srcH: number, rotation: number, panX: number, panY: number, zoom: number): CropFractions {
  const width = Number.isFinite(srcW) ? Math.max(0, srcW) : 0;
  const height = Number.isFinite(srcH) ? Math.max(0, srcH) : 0;
  const angle = normalizeRotation(rotation);
  const quarter = angle === 90 || angle === 270;
  const rw = quarter ? height : width;
  const rh = quarter ? width : height;
  if (rw < 1 || rh < 1) return { x: 0, y: 0, width: 1, height: 1 };
  const z = Math.min(3, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
  const px = Math.min(1, Math.max(-1, Number.isFinite(panX) ? panX : 0));
  const py = Math.min(1, Math.max(-1, Number.isFinite(panY) ? panY : 0));
  let cropW: number;
  let cropH: number;
  if (rw / rh > ASPECT) {
    cropH = rh;
    cropW = rh * ASPECT;
  } else {
    cropW = rw;
    cropH = rw / ASPECT;
  }
  cropW /= z;
  cropH /= z;
  const maxX = Math.max(0, rw - cropW);
  const maxY = Math.max(0, rh - cropH);
  const x = maxX / 2 + px * (maxX / 2);
  const y = maxY / 2 + py * (maxY / 2);
  return { x: x / rw, y: y / rh, width: cropW / rw, height: cropH / rh };
}
