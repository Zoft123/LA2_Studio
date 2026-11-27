// TXP: Metal Gear Solid: Peace Walker HD (PS3) texture packs, the textures of its .la3 layouts. Little-endian.
//
// header   {u32 flags, u32 own hash, u32 image count, u32 texture count, u32 ?, u32 image table, u32 texture table,
//          u32 data start}. flags 0: PSP-style paletted pixels inside the file; 1: DDS (DXT1 / DXT5) inside the file
//          (the HD port's redrawn textures); 2: pixels held elsewhere (model / effect textures, not decoded here).
// image    20 bytes {u16 format, u16 width, u16 height, u16 0, u32 0, u32 pixel offset, u32 0}; width / height are
//          log2(buffer size) << 12 | size. Format (low 3 bits) 4: 4-bit indices, 5: 8-bit indices (PSP swizzled,
//          RGBA8888 palette with full 0..255 alpha), 6: DDS at the texture's palette / data offset.
// texture  40 bytes {u32 flags, u32 hash, u32 image record offset, u32 palette (or DDS) offset, f32 u, f32 v,
//          f32 width, f32 height (fractions of the power-of-two buffer from the image's high nibbles),
//          u16 width, u16 height (layout texels), u32 ?}
// The DDS can be padded beyond that buffer (often to 128 rows); its stored dimensions do not rescale the rectangle.
// A texture is a rectangle of an image; layouts name it by (texture hash, TXP hash).
import { Reader } from '../core/bin.js';
import { decodeDxt } from './textures.js';

export const TXP_INLINE = 0, TXP_DDS = 1, TXP_EXTERNAL = 2;
const FMT_I4 = 4, FMT_I8 = 5, FMT_DDS = 6;
const DDS_MAGIC = 0x20534444;                                // "DDS "
const FOURCC = { 0x31545844: 9, 0x33545844: 10, 0x35545844: 11 }; // DXT1 / DXT3 / DXT5 -> decodeDxt codes

/** Key of a TXP texture in a TexturePool, like the PS2 TRI keys: txp << 24 | texture. */
export const txpTexKey = (tex, txp) => txp * 0x1000000 + tex;

/** Header, images and textures of a TXP, or null when the bytes are not one. */
export function parseTxp(bytes) {
  if (bytes.length < 32) return null;
  const r = new Reader(bytes, true);
  const flags = r.u32(0), hash = r.u32(4), nImg = r.u32(8), nTex = r.u32(12);
  const imgOff = r.u32(20), texOff = r.u32(24);
  if (imgOff !== 0x20 || nImg > 4096 || nTex > 4096 || imgOff + 20 * nImg > bytes.length || texOff + 40 * nTex > bytes.length) return null;
  const images = new Map();
  for (let i = 0; i < nImg; i++) {
    const o = imgOff + 20 * i, W = r.u16(o + 2), H = r.u16(o + 4);
    images.set(o, { offset: o, format: r.u16(o), w: W & 0xFFF, h: H & 0xFFF, bw: 1 << (W >> 12), bh: 1 << (H >> 12), pixels: r.u32(o + 12) });
  }
  const textures = [];
  for (let i = 0; i < nTex; i++) {
    const o = texOff + 40 * i;
    textures.push({
      index: i, flags: r.u32(o), hash: r.u32(o + 4), image: images.get(r.u32(o + 8)) || null, palette: r.u32(o + 12),
      u: r.f32(o + 16), v: r.f32(o + 20), uw: r.f32(o + 24), vh: r.f32(o + 28), w: r.u16(o + 32), h: r.u16(o + 34),
    });
  }
  return { flags, hash, images, textures };
}

/** Size of the image a texture lives in: the DDS's own size for DDS images, else the image buffer. */
export function txpImageSize(bytes, tex) {
  const im = tex.image;
  if (!im) return null;
  if ((im.format & 7) === FMT_DDS) {
    const r = new Reader(bytes, true), o = tex.palette;
    if (o + 128 > bytes.length || r.u32(o) !== DDS_MAGIC) return null;
    return { w: r.u32(o + 16), h: r.u32(o + 12) };
  }
  if (!im.pixels) return null;                                // pixels not in this file
  return { w: im.bw, h: im.bh };
}

/** PSP texture swizzle: the image is stored as 16-byte x 8-row blocks, left to right, top to bottom. */
function unswizzle(src, rowBytes, rows) {
  if (rowBytes < 16) return src;
  const out = new Uint8Array(rowBytes * rows);
  let i = 0;
  for (let by = 0; by < rows; by += 8)
    for (let bx = 0; bx < rowBytes; bx += 16)
      for (let y = by; y < by + 8; y++, i += 16) {
        if (y >= rows || i + 16 > src.length) continue;
        out.set(src.subarray(i, i + 16), y * rowBytes + bx);
      }
  return out;
}

/** Decoded RGBA8 of the image a texture lives in ({w, h, rgba}), or null when its pixels are not in the file. */
export function decodeTxpImage(bytes, tex) {
  const im = tex.image, size = txpImageSize(bytes, tex);
  if (!size) return null;
  const fmt = im.format & 7, { w, h } = size;
  if (fmt === FMT_DDS) {
    const r = new Reader(bytes, true), o = tex.palette;
    const pfFlags = r.u32(o + 80), fourcc = FOURCC[r.u32(o + 84)];
    const data = bytes.subarray(o + 128);
    if (fourcc) return { w, h, rgba: decodeDxt(w, h, fourcc, data) };
    if (pfFlags & 0x40 && r.u32(o + 88) === 32) {             // uncompressed 32-bit: masks say where each channel is
      const masks = [92, 96, 100, 104].map(k => r.u32(o + k)), rgba = new Uint8Array(w * h * 4);
      const shift = m => m ? 31 - Math.clz32(m & -m) : -1;
      const sh = masks.map(shift), dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let p = 0; p < w * h && 4 * p + 4 <= data.length; p++) {
        const v = dv.getUint32(4 * p, true);
        for (let c = 0; c < 4; c++) rgba[4 * p + c] = sh[c] < 0 ? 255 : (v >>> sh[c]) & 0xFF;
      }
      return { w, h, rgba };
    }
    return null;
  }
  if (fmt !== FMT_I4 && fmt !== FMT_I8) return null;
  const bpp = fmt === FMT_I4 ? 4 : 8, rowBytes = w * bpp / 8;
  const raw = unswizzle(bytes.subarray(im.pixels, im.pixels + rowBytes * h), rowBytes, h);
  const n = fmt === FMT_I4 ? 16 : 256, pal = bytes.subarray(tex.palette, tex.palette + 4 * n);
  if (pal.length < 4 * n) return null;
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const idx = fmt === FMT_I4 ? (raw[p >> 1] >> ((p & 1) * 4)) & 15 : raw[p];
    rgba.set(pal.subarray(4 * idx, 4 * idx + 4), 4 * p);
  }
  return { w, h, rgba };
}
