// Animation export in the browser.
//  - Animated WebP: each distinct frame is encoded by the browser's own WebP encoder (canvas.convertToBlob), and
//    its VP8 / VP8L (+ ALPH) chunks are wrapped in an ANIM / ANMF container. quality 1 = lossless where the browser
//    supports it.
//  - APNG: lossless, works in every browser (fallback where WebP encoding is unavailable).
// A frame identical to the previous one is not stored again: its time is added to the previous frame.
import { zlibSync } from '../vendor/fflate.js';
import { concat } from '../core/bin.js';

const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
const u32le = v => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
const u24le = v => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255);
const u32be = v => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const u16be = v => Uint8Array.of((v >>> 8) & 255, v & 255);

function chunk(id, data) {
  return concat([ascii(id), u32le(data.length), data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}

/** Can this browser encode WebP from a canvas? */
export async function webpSupported() {
  try {
    const c = new OffscreenCanvas(2, 2);
    c.getContext('2d');
    const b = await c.convertToBlob({ type: 'image/webp' });
    return b.type === 'image/webp';
  } catch (e) { return false; }
}

/** Frame chunks (VP8 / VP8L, optional ALPH) of a single-image WebP. */
function frameChunks(webp) {
  const out = [];
  let p = 12;
  const dv = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  while (p + 8 <= webp.length) {
    const id = String.fromCharCode(...webp.subarray(p, p + 4)), size = dv.getUint32(p + 4, true);
    if (id === 'VP8 ' || id === 'VP8L' || id === 'ALPH') out.push(webp.subarray(p, p + 8 + size + (size & 1)));
    p += 8 + size + (size & 1);
  }
  return out;
}

export class WebPWriter {
  constructor(w, h, quality = 1, loop = 0) {
    this.w = w; this.h = h; this.q = quality; this.loop = loop;
    this.canvas = new OffscreenCanvas(w, h);
    this.ctx = this.canvas.getContext('2d');
    this.frames = [];
  }
  async add(rgba, durationMs) {
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), this.w, this.h), 0, 0);
    const blob = await this.canvas.convertToBlob({ type: 'image/webp', quality: this.q });
    const chunks = frameChunks(new Uint8Array(await blob.arrayBuffer()));
    this.frames.push({ chunks, dur: durationMs });
  }
  extend(ms) { if (this.frames.length) this.frames[this.frames.length - 1].dur += ms; }
  finish() {
    const hasAlpha = this.frames.some(f => f.chunks.some(c => c[0] === 0x41) || f.chunks.some(c => String.fromCharCode(...c.subarray(0, 4)) === 'VP8L'));
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x02 | (hasAlpha ? 0x10 : 0);            // animation (+ alpha)
    vp8x.set(u24le(this.w - 1), 4); vp8x.set(u24le(this.h - 1), 7);
    const parts = [chunk('VP8X', vp8x), chunk('ANIM', concat([new Uint8Array(4), Uint8Array.of(this.loop & 255, this.loop >> 8)]))];
    for (const f of this.frames) {
      const hdr = concat([u24le(0), u24le(0), u24le(this.w - 1), u24le(this.h - 1), u24le(Math.max(1, Math.round(f.dur))), Uint8Array.of(0x02)]);
      parts.push(chunk('ANMF', concat([hdr, ...f.chunks])));
    }
    const body = concat(parts);
    return new Blob([concat([ascii('RIFF'), u32le(body.length + 4), ascii('WEBP'), body])], { type: 'image/webp' });
  }
}

// ---- APNG ---------------------------------------------------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(...parts) {
  let c = 0xFFFFFFFF;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(id, data) {
  const t = ascii(id);
  return concat([u32be(data.length), t, data, u32be(crc32(t, data))]);
}

export class APNGWriter {
  constructor(w, h, loop = 0) { this.w = w; this.h = h; this.loop = loop; this.frames = []; }
  async add(rgba, durationMs) {
    const row = this.w * 4, raw = new Uint8Array((row + 1) * this.h);
    for (let y = 0; y < this.h; y++) { raw[y * (row + 1)] = 0; raw.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1); }
    this.frames.push({ data: zlibSync(raw, { level: 6 }), dur: durationMs });
  }
  extend(ms) { if (this.frames.length) this.frames[this.frames.length - 1].dur += ms; }
  finish() {
    const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      pngChunk('IHDR', concat([u32be(this.w), u32be(this.h), Uint8Array.of(8, 6, 0, 0, 0)])),
      pngChunk('acTL', concat([u32be(this.frames.length), u32be(this.loop)]))];
    let seq = 0;
    this.frames.forEach((f, i) => {
      const ms = Math.max(1, Math.round(f.dur));
      parts.push(pngChunk('fcTL', concat([u32be(seq++), u32be(this.w), u32be(this.h), u32be(0), u32be(0),
        u16be(Math.min(65535, ms)), u16be(1000), Uint8Array.of(0, 0)])));
      parts.push(i === 0 ? pngChunk('IDAT', f.data) : pngChunk('fdAT', concat([u32be(seq++), f.data])));
    });
    parts.push(pngChunk('IEND', new Uint8Array(0)));
    return new Blob([concat(parts)], { type: 'image/png' });
  }
}

/** Single PNG of one frame. */
export function encodePNG(w, h, rgba) {
  const a = new APNGWriter(w, h);
  const row = w * 4, raw = new Uint8Array((row + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  return new Blob([concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk('IHDR', concat([u32be(w), u32be(h), Uint8Array.of(8, 6, 0, 0, 0)])),
    pngChunk('IDAT', zlibSync(raw, { level: 6 })), pngChunk('IEND', new Uint8Array(0))])], { type: 'image/png' });
}

/** FNV-1a over the pixels: cheap identity check between consecutive frames. */
export function frameHash(rgba) {
  let h = 0x811c9dc5;
  const w = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 0x01000193);
  return h >>> 0;
}
