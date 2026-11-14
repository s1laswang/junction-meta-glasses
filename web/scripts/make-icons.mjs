// Rasterises the HoldUp mark (yellow tile, ink viewfinder brackets, ink box) to PNG without dependencies.
// Usage: node web/scripts/make-icons.mjs  -> web/public/icons/icon-{192,512}.png, maskable-512.png
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "../public/icons");
mkdirSync(out, { recursive: true });

const Y = [0xff, 0xd2, 0x3f];
const INK = [0x0b, 0x10, 0x18];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// shapes in a 32-unit design space (same as Logo in Icons.tsx)
function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function nearSeg(x, y, ax, ay, bx, by, hw) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= hw * hw;
}
const SEGS = [
  [7, 12, 7, 8], [7, 8, 11, 8], [21, 8, 25, 8], [25, 8, 25, 12],
  [25, 20, 25, 24], [25, 24, 21, 24], [11, 24, 7, 24], [7, 24, 7, 20],
];
function sample(x, y, { full, scale }) {
  // scale < 1 shrinks the mark into the maskable safe zone
  const u = (x - 16) / scale + 16, v = (y - 16) / scale + 16;
  const tile = full ? true : inRoundRect(x, y, 0, 0, 32, 32, 8);
  if (!tile) return null;
  if (inRoundRect(u, v, 12.5, 11, 7, 10, 1.2)) return INK;
  if (SEGS.some(([a, b, c, d]) => nearSeg(u, v, a, b, c, d, 1.3))) return INK;
  return Y;
}
function render(size, opts) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(((x + (sx + 0.5) / ss) / size) * 32, ((y + (sy + 0.5) / ss) / size) * 32, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      const n = ss * ss, i = (y * size + x) * 4, cov = a / 255;
      px[i] = cov ? r / cov : 0; px[i + 1] = cov ? g / cov : 0; px[i + 2] = cov ? b / cov : 0; px[i + 3] = a / n;
    }
  return png(size, px);
}

writeFileSync(join(out, "icon-192.png"), render(192, { full: false, scale: 1 }));
writeFileSync(join(out, "icon-512.png"), render(512, { full: false, scale: 1 }));
writeFileSync(join(out, "maskable-512.png"), render(512, { full: true, scale: 0.78 }));
console.log("icons written to", out);
