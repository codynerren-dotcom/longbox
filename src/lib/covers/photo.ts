import sharp from "sharp";
import { normalizeRotation, portraitFrame, type CropFractions } from "@/lib/covers/portrait";

export const COVER_MAX_EDGE = 1200;
const PREVIEW_MAX_EDGE = 1600;
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heif", "mif1", "msf1"]);

export type PhotoKind = "jpg" | "png" | "webp" | "heic" | "heif";

export function sniffImage(bytes: Uint8Array): PhotoKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  const brand = heifBrand(bytes);
  if (!brand) return null;
  if (brand === "heif" || brand === "mif1" || brand === "msf1") return "heif";
  return "heic";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i] ?? 0);
  return text;
}

function heifBrand(bytes: Uint8Array): string | null {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return null;
  const major = ascii(bytes, 8, 12);
  if (HEIF_BRANDS.has(major)) return major;
  const size = ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const limit = Math.min(bytes.length, size > 16 ? size : 16);
  for (let i = 16; i + 4 <= limit; i += 4) {
    const brand = ascii(bytes, i, i + 4);
    if (HEIF_BRANDS.has(brand)) return brand;
  }
  return null;
}

export function readCrop(input: { x: unknown; y: unknown; width: unknown; height: unknown }): CropFractions | null {
  const x = fraction(input.x);
  const y = fraction(input.y);
  const width = fraction(input.width);
  const height = fraction(input.height);
  if (x == null || y == null || width == null || height == null) return null;
  if (width <= 0 || height <= 0 || width > 1 || height > 1) return null;
  if (x < -0.001 || y < -0.001 || x > 1 || y > 1) return null;
  if (x + width > 1.01 || y + height > 1.01) return null;
  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

/** HEIC and HEIF become JPEG here. The wasm decoder covers iPhone photos that libvips cannot read. */
export async function decodeHeic(bytes: Buffer): Promise<Buffer> {
  if (bytes.length < 64) throw new Error("Could not read that HEIC photo.");
  const convert = (await import("heic-convert")).default;
  try {
    const jpeg = await convert({ buffer: bytes, format: "JPEG", quality: 0.92 });
    return Buffer.from(jpeg);
  } catch {
    throw new Error("Could not read that HEIC photo.");
  }
}

export async function renderCover(bytes: Buffer, rotation: number, crop: CropFractions | null): Promise<Buffer> {
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("Upload a jpg, png, webp, or heic photo.");
  const raster = kind === "heic" || kind === "heif" ? await decodeHeic(bytes) : bytes;
  const oriented = await sharp(raster, { failOn: "none" }).rotate().toBuffer();
  const meta = await sharp(oriented).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1 || height < 1) throw new Error("Could not read that photo.");
  const angle = normalizeRotation(rotation);
  const turned = angle === 0 ? oriented : await sharp(oriented).rotate(angle).toBuffer();
  const turnedMeta = angle === 0 ? meta : await sharp(turned).metadata();
  const rw = turnedMeta.width ?? 0;
  const rh = turnedMeta.height ?? 0;
  if (rw < 1 || rh < 1) throw new Error("Could not read that photo.");
  const fractions = crop ?? portraitFrame(width, height, angle, 0, 0, 1);
  const left = clampInt(fractions.x * rw, 0, rw - 1);
  const top = clampInt(fractions.y * rh, 0, rh - 1);
  const cropW = clampInt(fractions.width * rw, 1, rw - left);
  const cropH = clampInt(fractions.height * rh, 1, rh - top);
  return sharp(turned)
    .extract({ left, top, width: cropW, height: cropH })
    .resize({ width: COVER_MAX_EDGE, height: COVER_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

export async function previewJpeg(bytes: Buffer): Promise<Buffer> {
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("Upload a jpg, png, webp, or heic photo.");
  const raster = kind === "heic" || kind === "heif" ? await decodeHeic(bytes) : bytes;
  return sharp(raster, { failOn: "none" })
    .rotate()
    .resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function fraction(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return null;
  return number;
}

function clampInt(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
