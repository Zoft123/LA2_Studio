// CTXR: the HD textures of the PS3 Metal Gear Solid 3 port (HD Collection / Master Collection PS3 data).
//
// The port keeps MGS3's layouts and .tri files, but its TRIs are stubs (image and CLUT blocks are zeros): every
// texture is replaced by "<texture hash>[-name].ctxr", one file per texture region, redrawn at a higher resolution.
// A CTXR is a GTF-like texture, big-endian:
//   u32 version 0x02000101, u32 data size, u32 count (1), u32 id, u32 data offset (0x80), u32 data size, then
//   either  +0x18 {u8 format, u8 mipmaps, u8 dimension, u8 cubemap, u32 remap, u16 width, u16 height, u32 depth}
//   or      +0x18 {u32, i32, u32 (unknown, e.g. 0x80, -128, 0)}, +0x24 {u8 format, u8 mipmaps, u8 dimension, u8 cubemap}
//   (most stage textures); both then have +0x28 u32 remap, +0x2C u16 width, u16 height, +0x30 u32 depth,
//   +0x34 u32 pitch (linear formats). Data at the data offset, top mip first.
// Formats: CELL_GCM_TEXTURE_* 0x85 A8R8G8B8, 0x9E D8R8G8B8 (opaque), 0x86 / 0x87 / 0x88 DXT1 / 3 / 5;
// flag 0x20 (LN) = linear rows of `pitch` bytes, otherwise RSX swizzled (Morton order); 0x40 (UN) = normalised
// coordinates, ignored here. Byte order of a 32-bit texel in memory: A R G B. Alpha keeps the PS2 scale
// (0x80 = opaque; upscaling overshoots it a little), so it is doubled and clamped like a TRI CLUT's.
import { decodeDxt } from './textures.js';

const LN = 0x20, UN = 0x40;
const alpha = a => Math.min(255, Math.round(a * 255 / 128));

/** Header of a CTXR: {format, linear, mips, w, h, pitch, offset} or null. */
export function parseCtxr(bytes) {
  if (bytes.length < 0x80) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, false) !== 0x02000101) return null;
  // the first layout repeats {remap, width, height} at +0x1C and +0x28; the second has other words at +0x18..+0x23
  const std = v.getUint32(0x1C, false) === v.getUint32(0x28, false) && v.getUint32(0x20, false) === v.getUint32(0x2C, false);
  const at = std ? 0x18 : 0x24, offset = v.getUint32(16, false), w = v.getUint16(0x2C, false), h = v.getUint16(0x2E, false);
  let fmt = bytes[at];
  // one file (result-normal 00593209) has format 0; its size and pitch are those of linear A8R8G8B8
  if (!fmt && v.getUint32(20, false) === w * h * 4 && v.getUint32(0x34, false) === w * 4) fmt = 0x85 | LN;
  if (!(fmt & 0x80) || !w || !h || offset > bytes.length) return null;
  return { format: fmt & ~(LN | UN), linear: !!(fmt & LN), mips: bytes[at + 1], w, h, pitch: v.getUint32(0x34, false), offset };
}

/** Swizzled (Morton) offset of texel (x, y) in a w x h RSX texture (powers of two). */
function swizzle(x, y, w, h) {
  let o = 0, bit = 0, sw = w, sh = h;
  while (sw > 1 || sh > 1) {
    if (sw > 1) { o |= (x & 1) << bit++; x >>= 1; sw >>= 1; }
    if (sh > 1) { o |= (y & 1) << bit++; y >>= 1; sh >>= 1; }
  }
  return o;
}

/** RGBA8 pixels of a CTXR's top mip, or null for formats this decoder does not know. */
export function decodeCtxr(bytes) {
  const t = parseCtxr(bytes);
  if (!t) return null;
  const { w, h, offset } = t, out = new Uint8Array(w * h * 4);
  if (t.format === 0x85 || t.format === 0x9E) {
    const opaque = t.format === 0x9E, pitch = t.linear ? (t.pitch || w * 4) : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = offset + (t.linear ? y * pitch + x * 4 : swizzle(x, y, w, h) * 4), o = (y * w + x) * 4;
      if (s + 4 > bytes.length) continue;
      out[o] = bytes[s + 1]; out[o + 1] = bytes[s + 2]; out[o + 2] = bytes[s + 3]; out[o + 3] = opaque ? 255 : alpha(bytes[s]);
    }
    return { w, h, rgba: out };
  }
  const dxt = { 0x86: 9, 0x87: 10, 0x88: 11 }[t.format];
  if (!dxt) return null;
  const rgba = decodeDxt(w, h, dxt, bytes.subarray(offset));
  if (dxt !== 9) for (let i = 3; i < rgba.length; i += 4) rgba[i] = alpha(rgba[i]);
  return { w, h, rgba };
}

/** Texture hash a CTXR file is named by ("0020c1dc.ctxr", "0014b65a-transfarring_….ctxr"), or null. */
export function ctxrHash(name) {
  const m = /^([0-9a-f]{8})(?:[-_.].*)?\.ctxr$/i.exec(name);
  if (!m) return null;
  const h = parseInt(m[1], 16);
  return h <= 0xFFFFFF ? h : null;
}

/** Folders that may hold the CTXRs of a layout / TRI folder, most specific first: the folder and its _ps3
 *  subfolder, then the same below the language-neutral tree (mgs3/us/stage/x/cache -> mgs3/stage/x/cache/_ps3). */
export function ctxrDirs(dir) {
  const out = [dir, dir + '/_ps3'];
  const parts = dir.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    if ((parts[i] === 'stage' || parts[i] === 'slot') && /^[a-z]{2}$/i.test(parts[i - 1])) {
      const shared = [...parts.slice(0, i - 1), ...parts.slice(i)].join('/');
      out.push(shared, shared + '/_ps3');
      break;
    }
  }
  return out;
}

/** The texture's place in its CTXR: the TRI region (u, v, w, h, in GS texels) covers whole texels from
 *  floor(u) to u + w + frac(u), i.e. its rectangle is texel-centred; the CTXR redraws exactly those texels.
 *  Returns {u0, v0, uw, vh} in CTXR pixels. A record with an empty region (PS3-only textures) uses the whole image. */
export function ctxrRegion(rec, w, h) {
  if (!(rec.w > 0 && rec.h > 0)) return { u0: 0, v0: 0, uw: w, vh: h };
  const fu = rec.u - Math.floor(rec.u), fv = rec.v - Math.floor(rec.v);
  const sx = w / (rec.w + 2 * fu), sy = h / (rec.h + 2 * fv);
  return { u0: fu * sx, v0: fv * sy, uw: rec.w * sx, vh: rec.h * sy };
}
