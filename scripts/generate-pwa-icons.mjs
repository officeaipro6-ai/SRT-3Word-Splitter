/**
 * Generates the PWA icon set as REAL PNG files with zero dependencies
 * (Node built-ins only: zlib + manual PNG chunk/CRC encoding).
 *
 * Design: indigo->blue gradient rounded square with a white audio-waveform.
 * `maskable-512.png` uses the same motif but full-bleed background and the
 * motif kept inside Chrome's safe-zone circle (80% diameter), so it renders
 * correctly when the OS masks it.
 *
 * Usage: `node scripts/generate-pwa-icons.mjs`
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// ---- Minimal PNG encoder ----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines: each row prefixed with filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Drawing helpers ---------------------------------------------------------
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function roundedRectAlpha(x, y, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 || dy === 0) return 1;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d <= r ? 1 : 0;
}

/**
 * Render the audio-waveform motif centered in the given box (safe zone).
 */
function makeIcon(size, { maskable = false, radiusRatio = 0.18 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const top = hexToRgb('#4f46e5'); // indigo-600
  const bottom = hexToRgb('#2563eb'); // blue-600
  const radius = Math.round(size * radiusRatio);

  let safeCx = size / 2;
  let safeCy = size / 2;
  let safeR = size / 2;
  if (maskable) {
    // Chrome maskable safe zone: central circle of 80% of the icon size.
    safeR = size * 0.4;
  }
  const contentScale = maskable ? 0.42 : 0.5;
  const barCount = 5;
  const barW = (size * contentScale) / (barCount * 2.4 + (barCount - 1));
  const gap = barW * 0.8;
  const totalW = barCount * barW + (barCount - 1) * gap;
  const heights = [0.42, 0.72, 1.0, 0.62, 0.34];

  for (let y = 0; y < size; y++) {
    // vertical gradient
    const t = maskable ? y / size : Math.min(1, Math.max(0, y / size));
    const cr = lerp(top[0], bottom[0], Math.pow(t, 1.2));
    const cg = lerp(top[1], bottom[1], Math.pow(t, 1.2));
    const cb = lerp(top[2], bottom[2], Math.pow(t, 1.2));
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dist = Math.sqrt((x - safeCx) ** 2 + (y - safeCy) ** 2);
      const alpha = maskable ? 1 : roundedRectAlpha(x + 0.5, y + 0.5, size, radius);
      rgba[idx] = cr;
      rgba[idx + 1] = cg;
      rgba[idx + 2] = cb;
      rgba[idx + 3] = Math.round(alpha * 255);

      // waveform bars (drawn in the safe zone)
      const startX = safeCx - totalW / 2;
      for (let b = 0; b < barCount; b++) {
        const bx0 = startX + b * (barW + gap);
        const hFrac = heights[b];
        const barH = size * contentScale * hFrac;
        const by0 = safeCy - barH / 2;
        if (x >= bx0 && x < bx0 + barW && y >= by0 && y < by0 + barH) {
          rgba[idx] = 255;
          rgba[idx + 1] = 255;
          rgba[idx + 2] = 255;
        }
      }
      // subtle shadow ring for non-maskable (keep alpha 1 fully inside)
      const edge = Math.max(0, Math.min(1, (dist - size * 0.42 + 4) / 8));
      if (alpha === 1 && !maskable) {
        rgba[idx + 3] = 255;
      }
      void edge;
    }
  }
  return rgba;
}

function write(name, size, opts) {
  const png = encodePng(size, size, makeIcon(size, opts));
  const file = path.join(outDir, name);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${size}x${size}, ${png.length} bytes)`);
}

write('icon-192.png', 192, {});
write('icon-512.png', 512, {});
write('maskable-512.png', 512, { maskable: true });
write('favicon-32.png', 32, { radiusRatio: 0.2 });
write('favicon-16.png', 16, { radiusRatio: 0.2 });
write('apple-touch-icon.png', 180, {});
console.log('done.');