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

/**
 * Change between two RGBA frames: the bounding box of differing pixels (x and y rounded down to even, as WebP
 * frame offsets require), or null if identical.
 */
export function diffRect(prev, cur, w, h) {
  const a = new Uint32Array(prev.buffer, prev.byteOffset, w * h), b = new Uint32Array(cur.buffer, cur.byteOffset, w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (a[row + x] !== b[row + x]) { first = x; break; }
    if (first < 0) continue;
    for (let x = w - 1; x >= first; x--) if (a[row + x] !== b[row + x]) { last = x; break; }
    if (y < y0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  if (x1 < 0) return null;
  x0 &= ~1; y0 &= ~1;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Crop `r` of the current frame. With `transparent`, pixels equal to the previous frame become fully transparent
 * (the frame is alpha-blended over the previous one, so the result is exact while unchanged areas cost almost
 * nothing to store). Frames are opaque, so transparency only ever marks "unchanged".
 */
export function cropDelta(prev, cur, w, r, transparent) {
  const out = new Uint8Array(r.w * r.h * 4);
  const o32 = new Uint32Array(out.buffer), c32 = new Uint32Array(cur.buffer, cur.byteOffset, cur.length >> 2);
  const p32 = prev ? new Uint32Array(prev.buffer, prev.byteOffset, prev.length >> 2) : null;
  for (let y = 0; y < r.h; y++) {
    const src = (r.y + y) * w + r.x, dst = y * r.w;
    for (let x = 0; x < r.w; x++) {
      const v = c32[src + x];
      o32[dst + x] = transparent && p32 && p32[src + x] === v ? 0 : v;
    }
  }
  return out;
}

/** Integer-millisecond durations from exact ones without drift: each frame lasts until the next rounded timestamp. */
function roundDurations(frames) {
  let t = 0, prev = 0;
  for (const f of frames) { t += f.dur; const r = Math.round(t); f.ms = Math.max(1, r - prev); prev = r; }
}

/** Shared bookkeeping: frames only store what changed since the previous frame. */
class DeltaWriter {
  constructor(w, h) { this.w = w; this.h = h; this.prev = null; this.frames = []; this.stored = 0; }
  /** Add a frame of `durationMs`; returns false if it was identical to the previous one (time merged). */
  async add(rgba, durationMs) {
    if (this.prev) {
      const r = diffRect(this.prev, rgba, this.w, this.h);
      if (!r) { this.frames[this.frames.length - 1].dur += durationMs; return false; }
      await this.encode(rgba, r, durationMs);
    } else await this.encode(rgba, { x: 0, y: 0, w: this.w, h: this.h }, durationMs);
    this.prev = rgba.slice();
    this.stored++;
    return true;
  }
}

export class WebPWriter extends DeltaWriter {
  /** quality 1 = lossless (unchanged pixels transparent + alpha blending), lower = lossy (changed rectangle only). */
  constructor(w, h, quality = 1, loop = 0) {
    super(w, h);
    this.q = quality; this.loop = loop; this.lossless = quality >= 1;
  }
  async encode(rgba, r, dur) {
    const first = !this.prev, blend = this.lossless && !first;
    const px = first ? rgba : cropDelta(this.prev, rgba, this.w, r, blend);
    const c = new OffscreenCanvas(r.w, r.h);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), r.w, r.h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: this.q });
    this.frames.push({ chunks: frameChunks(new Uint8Array(await blob.arrayBuffer())), dur, r, blend });
  }
  finish() {
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x02 | 0x10;                              // animation + alpha
    vp8x.set(u24le(this.w - 1), 4); vp8x.set(u24le(this.h - 1), 7);
    const parts = [chunk('VP8X', vp8x), chunk('ANIM', concat([new Uint8Array(4), Uint8Array.of(this.loop & 255, this.loop >> 8)]))];
    let size = parts.reduce((a, p) => a + p.length, 0);
    roundDurations(this.frames);
    for (const f of this.frames) {
      // ANMF: x / 2, y / 2, width - 1, height - 1, duration, flags (bit 1 = do not blend, bit 0 = dispose)
      const hdr = concat([u24le(f.r.x >> 1), u24le(f.r.y >> 1), u24le(f.r.w - 1), u24le(f.r.h - 1),
        u24le(Math.min(0xFFFFFF, f.ms)), Uint8Array.of(f.blend ? 0x00 : 0x02)]);
      const len = hdr.length + f.chunks.reduce((a, c) => a + c.length, 0);
      parts.push(ascii('ANMF'), u32le(len), hdr, ...f.chunks);
      if (len & 1) parts.push(new Uint8Array(1));
      size += 8 + len + (len & 1);
    }
    return new Blob([ascii('RIFF'), u32le(size + 4), ascii('WEBP'), ...parts], { type: 'image/webp' });
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

export class APNGWriter extends DeltaWriter {
  /** Lossless; frames after the first store only their changed rectangle, unchanged pixels transparent and blended. */
  constructor(w, h, loop = 0) { super(w, h); this.loop = loop; }
  async encode(rgba, r, dur) {
    const first = !this.prev;
    const px = first ? rgba : cropDelta(this.prev, rgba, this.w, r, true);
    const row = r.w * 4, raw = new Uint8Array((row + 1) * r.h);
    for (let y = 0; y < r.h; y++) raw.set(px.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
    this.frames.push({ data: zlibSync(raw, { level: 6 }), dur, r, blend: !first });
  }
  finish() {
    const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      pngChunk('IHDR', concat([u32be(this.w), u32be(this.h), Uint8Array.of(8, 6, 0, 0, 0)])),
      pngChunk('acTL', concat([u32be(this.frames.length), u32be(this.loop)]))];
    let seq = 0;
    roundDurations(this.frames);
    this.frames.forEach((f, i) => {
      const ms = f.ms;
      // fcTL: delay as a fraction (numerator / denominator); 1/1000 s units, split if longer than 65.535 s
      const num = ms > 65535 ? Math.round(ms / 10) : ms, den = ms > 65535 ? 100 : 1000;
      parts.push(pngChunk('fcTL', concat([u32be(seq++), u32be(f.r.w), u32be(f.r.h), u32be(f.r.x), u32be(f.r.y),
        u16be(Math.min(65535, num)), u16be(den), Uint8Array.of(0, f.blend ? 1 : 0)])));
      parts.push(i === 0 ? pngChunk('IDAT', f.data) : pngChunk('fdAT', concat([u32be(seq++), f.data])));
    });
    parts.push(pngChunk('IEND', new Uint8Array(0)));
    return new Blob(parts, { type: 'image/png' });
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

// ---- video (WebCodecs) ----------------------------------------------------------------------------------------
// Video codecs predict each frame from earlier ones, so full-screen motion and fades cost little: typically tens
// of times smaller than lossless images for the same clip.
//  - AV1 4:4:4: RGB goes straight into the Y / U / V planes (G, B, R) with the identity colour matrix, so there is
//    no colour conversion or chroma subsampling; at the default quality it is visually lossless (> 50 dB PSNR).
//  - VP9 (WebM) and H.264 (MP4): 4:2:0, very widely playable.
import * as WebM from '../vendor/webm-muxer.js';
import * as MP4 from '../vendor/mp4-muxer.js';

export const VIDEO_FORMATS = {
  // quantizer 0-63: measured on an MGS4 full-screen clip, q14 ~ 55 dB, q28 ~ 52 dB, q36 ~ 51.5 dB PSNR
  'av1-444-hq': { label: 'AV1 4:4:4 high quality (.webm)', codec: 'av01.1.08M.08', mux: 'webm', track: 'V_AV1', q: 14, i444: true, ext: 'webm', mime: 'video/webm' },
  'av1-444': { label: 'AV1 4:4:4 near-lossless (.webm)', codec: 'av01.1.08M.08', mux: 'webm', track: 'V_AV1', q: 28, i444: true, ext: 'webm', mime: 'video/webm' },
  'av1-444-small': { label: 'AV1 4:4:4 compact (.webm)', codec: 'av01.1.08M.08', mux: 'webm', track: 'V_AV1', q: 36, i444: true, ext: 'webm', mime: 'video/webm' },
  'vp9': { label: 'VP9 (.webm)', codec: 'vp09.00.10.08', mux: 'webm', track: 'V_VP9', q: 8, ext: 'webm', mime: 'video/webm' },
  'h264': { label: 'H.264 (.mp4)', codec: ['avc1.640034', 'avc1.640033', 'avc1.64002A'], mux: 'mp4', track: 'avc', bpp: 0.12, ext: 'mp4', mime: 'video/mp4' },
};

/** Muxer output gathered in memory (writes may revisit earlier positions to patch sizes). */
class MemorySink {
  constructor() { this.parts = []; this.size = 0; }
  write(data, pos) {
    data = data.slice();
    if (pos === this.size) { this.parts.push({ pos, data }); this.size += data.length; return; }
    let end = pos + data.length;
    for (const p of this.parts) {           // overwrite whatever overlaps
      const a = Math.max(pos, p.pos), b = Math.min(end, p.pos + p.data.length);
      if (a < b) p.data.set(data.subarray(a - pos, b - pos), a - p.pos);
    }
    if (end > this.size) { const tail = data.subarray(Math.max(0, this.size - pos)); this.parts.push({ pos: this.size, data: tail }); this.size = end; }
  }
  blob(mime) { return new Blob(this.parts.map(p => p.data), { type: mime }); }
}

/** Which video formats this browser can encode at w x h. */
export async function videoFormats(w, h) {
  const out = {};
  if (typeof VideoEncoder === 'undefined') return out;
  for (const [k, f] of Object.entries(VIDEO_FORMATS)) {
    for (const codec of [].concat(f.codec)) {
      const cfg = { codec, width: w, height: h, framerate: 30, ...(f.q !== undefined ? { bitrateMode: 'quantizer' } : { bitrate: 8e6 }) };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) { out[k] = codec; break; } } catch (e) { /* unsupported */ }
    }
  }
  return out;
}

export class VideoWriter {
  /** fmt: key of VIDEO_FORMATS; codec: the supported codec string; file: optional FileSystemFileHandle to stream to. */
  constructor(fmt, codec, w, h, fps) {
    this.f = VIDEO_FORMATS[fmt]; this.codec = codec;
    this.w = w + (w & 1); this.h = h + (h & 1);        // encoders need even sizes
    this.fps = fps; this.n = 0; this.err = null;
    this.canvas = new OffscreenCanvas(this.w, this.h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: !!this.f.i444 });
  }
  async open(fileHandle = null) {
    const f = this.f, M = f.mux === 'mp4' ? MP4 : WebM;
    if (fileHandle) {
      this.writable = await fileHandle.createWritable();
      this.target = new M.FileSystemWritableFileStreamTarget(this.writable);
    } else {
      this.sink = new MemorySink();
      this.target = new M.StreamTarget({ onData: (d, p) => this.sink.write(d, p), chunked: true, chunkSize: 1 << 24 });
    }
    this.muxer = f.mux === 'mp4'
      ? new MP4.Muxer({ target: this.target, video: { codec: 'avc', width: this.w, height: this.h }, fastStart: false, firstTimestampBehavior: 'offset' })
      : new WebM.Muxer({ target: this.target, video: { codec: f.track, width: this.w, height: this.h, frameRate: this.fps }, firstTimestampBehavior: 'offset' });
    this.enc = new VideoEncoder({ output: (c, m) => this.muxer.addVideoChunk(c, m), error: e => { this.err = e; } });
    this.enc.configure({ codec: this.codec, width: this.w, height: this.h, framerate: this.fps,
      ...(f.q !== undefined ? { bitrateMode: 'quantizer' } : { bitrate: Math.round(this.w * this.h * this.fps * f.bpp), bitrateMode: 'variable' }),
      ...(f.mux === 'mp4' ? { avc: { format: 'avc' } } : {}) });
  }
  /** Add one frame from a canvas (the renderer's), held for `durationMs`. */
  async add(source, bg, durationMs) {
    if (this.err) throw this.err;
    const ctx = this.ctx, us = Math.round(this.n * durationMs * 1000);
    ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.drawImage(source, 0, 0);
    let frame;
    if (this.f.i444) {
      const px = ctx.getImageData(0, 0, this.w, this.h).data, n = this.w * this.h, buf = new Uint8Array(n * 3);
      for (let i = 0, j = 0; i < n; i++, j += 4) { buf[i] = px[j + 1]; buf[n + i] = px[j + 2]; buf[2 * n + i] = px[j]; }
      frame = new VideoFrame(buf, { format: 'I444', codedWidth: this.w, codedHeight: this.h, timestamp: us, duration: Math.round(durationMs * 1000),
        colorSpace: { matrix: 'rgb', primaries: 'bt709', transfer: 'iec61966-2-1', fullRange: true } });
    } else frame = new VideoFrame(this.canvas, { timestamp: us, duration: Math.round(durationMs * 1000) });
    const opts = { keyFrame: this.n % Math.max(1, Math.round(2 * this.fps)) === 0 };
    if (this.f.q !== undefined) opts[this.f.track === 'V_VP9' ? 'vp9' : 'av1'] = { quantizer: this.f.q };
    this.enc.encode(frame, opts);
    frame.close();
    this.n++;
    while (this.enc.encodeQueueSize > 3) await new Promise(r => setTimeout(r, 2));
  }
  /** Finish encoding; returns a Blob (in-memory output) or null (streamed to the chosen file). */
  async finish() {
    await this.enc.flush();
    if (this.err) throw this.err;
    this.enc.close();
    this.muxer.finalize();
    if (this.writable) { await this.writable.close(); return null; }
    return this.sink.blob(this.f.mime);
  }
  async abort() {
    try { this.enc.close(); } catch (e) { /* closed */ }
    if (this.writable) try { await this.writable.abort(); } catch (e) { /* closed */ }
  }
}
