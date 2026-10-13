import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function png(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixels(x, y, size);
      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function inRoundRect(x, y, size, margin, radius) {
  const left = margin;
  const top = margin;
  const right = size - margin;
  const bottom = size - margin;
  if (x < left || y < top || x >= right || y >= bottom) return false;
  const cornerX = x < left + radius ? left + radius : x >= right - radius ? right - radius - 1 : x;
  const cornerY = y < top + radius ? top + radius : y >= bottom - radius ? bottom - radius - 1 : y;
  if ((x < left + radius || x >= right - radius) && (y < top + radius || y >= bottom - radius)) {
    const dx = x - cornerX;
    const dy = y - cornerY;
    return dx * dx + dy * dy <= radius * radius;
  }
  return true;
}

function letter(x, y, size, kind) {
  const col = (n) => Math.round(size * n);
  const box = (x0, y0, x1, y1) => x >= col(x0) && x < col(x1) && y >= col(y0) && y < col(y1);
  if (kind === "L") return box(0.22, 0.28, 0.36, 0.74) || box(0.22, 0.62, 0.48, 0.74);
  return (
    box(0.54, 0.28, 0.66, 0.74) ||
    box(0.66, 0.28, 0.82, 0.4) ||
    box(0.66, 0.46, 0.82, 0.56) ||
    box(0.66, 0.62, 0.82, 0.74) ||
    box(0.76, 0.4, 0.84, 0.46) ||
    box(0.76, 0.56, 0.84, 0.62)
  );
}

function paint(maskable) {
  return (x, y, size) => {
    const margin = Math.round(size * (maskable ? 0.18 : 0.08));
    const radius = Math.round(size * 0.18);
    if (!inRoundRect(x, y, size, margin, radius)) return [13, 14, 18, 255];
    const ink = letter(x, y, size, "L") || letter(x, y, size, "B");
    if (ink) return [13, 14, 18, 255];
    const dot = (x + y) % Math.max(6, Math.round(size / 28)) === 0;
    if (dot) return [214, 164, 18, 255];
    return [255, 204, 26, 255];
  };
}

const directory = path.join(process.cwd(), "public/icons");
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, "icon-192.png"), png(192, paint(false)));
writeFileSync(path.join(directory, "icon-512.png"), png(512, paint(false)));
writeFileSync(path.join(directory, "icon-maskable-512.png"), png(512, paint(true)));
writeFileSync(path.join(directory, "apple-touch-icon.png"), png(180, paint(false)));
console.log("Wrote icons to public/icons");
