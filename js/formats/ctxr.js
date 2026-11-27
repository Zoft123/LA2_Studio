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

const MAGIC = 0x02000101;
const HEADER = {
  dataOffset: 0x10, dataSize: 0x14,
  descriptor: 0x18,          // {format, mipmaps, dimension, cubemap} in the first header layout
  descriptorAlt: 0x24,       // ... in the second layout (most stage textures)
  firstRemap: 0x1C, firstWidthHeight: 0x20,   // first layout only: copies of remap and width/height
  remap: 0x28, width: 0x2C, height: 0x2E, depth: 0x30, pitch: 0x34,
  size: 0x80,
};

// CELL_GCM_TEXTURE_* formats (without the flag bits below)
const FORMAT = { A8R8G8B8: 0x85, DXT1: 0x86, DXT3: 0x87, DXT5: 0x88, D8R8G8B8: 0x9E };
const GCM_FORMAT_BIT = 0x80;             // set on every GCM texture format
const LINEAR = 0x20, NORMALIZED = 0x40;   // CELL_GCM_TEXTURE_LN / _UN flag bits
/** DXT formats -> the FOURCC numbers decodeDxt takes (9 DXT1, 10 DXT3, 11 DXT5). */
const DXT_FOURCC = { [FORMAT.DXT1]: 9, [FORMAT.DXT3]: 10, [FORMAT.DXT5]: 11 };

/** PS2 alpha is 0..128 (128 = opaque); scale it to 0..255. */
const ps2Alpha = a => Math.min(255, Math.round(a * 255 / 128));

/** Header of a CTXR: {format, linear, mips, w, h, pitch, offset} or null. */
export function parseCtxr(bytes) {
  if (bytes.length < HEADER.size) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = at => view.getUint32(at, false), u16 = at => view.getUint16(at, false);
  if (u32(0) !== MAGIC) return null;

  // The first layout repeats {remap, width, height} at +0x1C and +0x28; the second has other words at +0x18..+0x23.
  const firstLayout = u32(HEADER.firstRemap) === u32(HEADER.remap) && u32(HEADER.firstWidthHeight) === u32(HEADER.width);
  const descriptor = firstLayout ? HEADER.descriptor : HEADER.descriptorAlt;
  const offset = u32(HEADER.dataOffset), w = u16(HEADER.width), h = u16(HEADER.height), pitch = u32(HEADER.pitch);
  let format = bytes[descriptor];
  // One file (result-normal 00593209) has format 0; its size and pitch are those of linear A8R8G8B8.
  if (!format && u32(HEADER.dataSize) === w * h * 4 && pitch === w * 4) format = FORMAT.A8R8G8B8 | LINEAR;
  if (!(format & GCM_FORMAT_BIT) || !w || !h || offset > bytes.length) return null;
  return { format: format & ~(LINEAR | NORMALIZED), linear: !!(format & LINEAR), mips: bytes[descriptor + 1], w, h, pitch, offset };
}

/** Swizzled (Morton) texel index of (x, y) in a w x h RSX texture (powers of two): the bits of x and y are
 *  interleaved, x first, until the smaller dimension runs out; the rest come from the larger one. */
function swizzle(x, y, w, h) {
  let index = 0, bit = 0;
  for (let sw = w, sh = h; sw > 1 || sh > 1;) {
    if (sw > 1) { index |= (x & 1) << bit++; x >>= 1; sw >>= 1; }
    if (sh > 1) { index |= (y & 1) << bit++; y >>= 1; sh >>= 1; }
  }
  return index;
}

/** RGBA8 pixels of a CTXR's top mip, or null for formats this decoder does not know. */
export function decodeCtxr(bytes) {
  const t = parseCtxr(bytes);
  if (!t) return null;
  const { w, h, offset } = t;

  if (t.format === FORMAT.A8R8G8B8 || t.format === FORMAT.D8R8G8B8) {
    const opaque = t.format === FORMAT.D8R8G8B8;
    const pitch = t.linear ? (t.pitch || w * 4) : 0;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = offset + (t.linear ? y * pitch + x * 4 : swizzle(x, y, w, h) * 4);
        if (src + 4 > bytes.length) continue;
        const o = (y * w + x) * 4;                    // texel in memory: A R G B
        out[o] = bytes[src + 1];
        out[o + 1] = bytes[src + 2];
        out[o + 2] = bytes[src + 3];
        out[o + 3] = opaque ? 255 : ps2Alpha(bytes[src]);
      }
    }
    return { w, h, rgba: out };
  }

  const fourcc = DXT_FOURCC[t.format];
  if (!fourcc) return null;
  const rgba = decodeDxt(w, h, fourcc, bytes.subarray(offset));
  if (t.format !== FORMAT.DXT1) for (let i = 3; i < rgba.length; i += 4) rgba[i] = ps2Alpha(rgba[i]);
  return { w, h, rgba };
}

/** Texture hash a CTXR file is named by ("0020c1dc.ctxr", "0014b65a-transfarring_….ctxr"), or null. */
export function ctxrHash(name) {
  const match = /^([0-9a-f]{8})(?:[-_.].*)?\.ctxr$/i.exec(name);
  if (!match) return null;
  const hash = parseInt(match[1], 16);
  return hash <= 0xFFFFFF ? hash : null;              // texture hashes are 24-bit
}

/** Folders that may hold the CTXRs of a layout / TRI folder, most specific first: the folder and its _ps3
 *  subfolder, then the same below the language-neutral tree (mgs3/us/stage/x/cache -> mgs3/stage/x/cache/_ps3). */
export function ctxrDirs(dir) {
  const out = [dir, dir + '/_ps3'];
  const parts = dir.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const isLanguageFolder = /^[a-z]{2}$/i.test(parts[i - 1]);        // "us", "jp", ...
    if ((parts[i] === 'stage' || parts[i] === 'slot') && isLanguageFolder) {
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
  const fracU = rec.u - Math.floor(rec.u), fracV = rec.v - Math.floor(rec.v);
  const scaleX = w / (rec.w + 2 * fracU), scaleY = h / (rec.h + 2 * fracV);   // CTXR pixels per GS texel
  return { u0: fracU * scaleX, v0: fracV * scaleY, uw: rec.w * scaleX, vh: rec.h * scaleY };
}
