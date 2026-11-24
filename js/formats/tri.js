// TRI: the PS2 texture groups of Metal Gear Solid 3 / Metal Gear Online (Subsistence). Little-endian.
//
// header   {u32 0, u32 width, u32 height, u32 clutHeight, u32 textureCount, u32 0, u32 imageOffset, u32 clutOffset}
// records  textureCount x 0xA0 bytes (0xC0 in "padded" files, 32 more zero bytes after the hash):
//          {f32 u, f32 v, f32 uScale, f32 vScale (fractions of the GS texture), u32 texture hash, ...,
//           u64 TEX0 at +80 (+112 padded), ...}
// data     the image and CLUT blocks are GS local memory: written as PSMCT32 rectangles 64 px wide (buffer width 1),
//          then each texture is read back through its TEX0 (TBP0 / TBW / PSM T4 or T8 / TW / TH, CLUT at CBP + CSA).
// A texture is the region (u, v, uScale, vScale) of the TW x TH GS texture; several textures share one GS texture
// (an atlas) and one CLUT block. Texture hashes repeat across TRIs, so a texture is named by (texture hash, TRI hash).
//
// GS addressing tables and the decoding steps follow otac0n/Codec's TriFile.cs (MIT licence, (c) John Gietzen).

const block32 = [0, 1, 4, 5, 16, 17, 20, 21, 2, 3, 6, 7, 18, 19, 22, 23, 8, 9, 12, 13, 24, 25, 28, 29, 10, 11, 14, 15, 26, 27, 30, 31];
const columnWord32 = [0, 1, 4, 5, 8, 9, 12, 13, 2, 3, 6, 7, 10, 11, 14, 15];
const block4 = [0, 2, 8, 10, 1, 3, 9, 11, 4, 6, 12, 14, 5, 7, 13, 15, 16, 18, 24, 26, 17, 19, 25, 27, 20, 22, 28, 30, 21, 23, 29, 31];
const A = [0, 1, 4, 5, 8, 9, 12, 13], B = [2, 3, 6, 7, 10, 11, 14, 15], C = [8, 9, 12, 13, 0, 1, 4, 5], D = [10, 11, 14, 15, 2, 3, 6, 7];
const rep = (a, n) => Array.from({ length: n }, () => a).flat();
const columnWord8 = [[...rep(A, 2), ...rep(B, 2), ...rep(C, 2), ...rep(D, 2)], [...rep(C, 2), ...rep(D, 2), ...rep(A, 2), ...rep(B, 2)]];
const columnByte8 = [...rep([...Array(8).fill(0), ...Array(8).fill(2)], 2), ...rep([...Array(8).fill(1), ...Array(8).fill(3)], 2)];
const columnWord4 = [[...rep(A, 4), ...rep(B, 4), ...rep(C, 4), ...rep(D, 4)], [...rep(C, 4), ...rep(D, 4), ...rep(A, 4), ...rep(B, 4)]];
const columnByte4 = [...rep([0, 2, 4, 6].flatMap(v => Array(8).fill(v)), 2), ...rep([1, 3, 5, 7].flatMap(v => Array(8).fill(v)), 2)];

export const PSMT8 = 0x13, PSMT4 = 0x14;

/** Word index of a PSMCT32 pixel. */
function addr32(dbp, dbw, x, y) {
  const page = (x >> 6) + (y >> 5) * dbw, px = x & 63, py = y & 31;
  const block = block32[(px >> 3) + (py >> 3) * 8], bx = px & 7, by = py & 7;
  return dbp * 64 + page * 2048 + block * 64 + (by >> 1) * 16 + columnWord32[bx + (by & 1) * 8];
}

function write32(mem, h, src, off) {
  const n = Math.min(64 * h, (src.length - off) >> 2);
  const dv = new DataView(src.buffer, src.byteOffset + off, n * 4);
  for (let i = 0; i < n; i++) mem[addr32(0, 1, i & 63, i >> 6)] = dv.getUint32(4 * i, true);
}

function read8(mem, dbp, dbw, x, y) {
  dbw >>= 1;
  const page = (x >> 7) + (y >> 6) * dbw, px = x & 127, py = y & 63;
  const block = block32[(px >> 4) + (py >> 4) * 8], bx = px & 15, by = py & 15, col = by >> 2, cy = by & 3;
  const w = mem[dbp * 64 + page * 2048 + block * 64 + col * 16 + columnWord8[col & 1][bx + cy * 16]];
  return (w >>> (8 * columnByte8[bx + cy * 16])) & 0xFF;
}

function read4(mem, dbp, dbw, x, y) {
  dbw >>= 1;
  const page = (x >> 7) + (y >> 7) * dbw, px = x & 127, py = y & 127;
  const block = block4[(px >> 5) + (py >> 4) * 4], bx = px & 31, by = py & 15, col = by >> 2, cy = by & 3;
  const w = mem[dbp * 64 + page * 2048 + block * 64 + col * 16 + columnWord4[col & 1][bx + cy * 32]];
  return (w >>> (4 * columnByte4[bx + cy * 32])) & 0xF;
}

/** Decoded TEX0 fields. */
function tex0(lo, hi) {
  return {
    tbp: lo & 0x3FFF, tbw: (lo >>> 14) & 0x3F, psm: (lo >>> 20) & 0x3F,
    tw: 1 << ((lo >>> 26) & 0xF), th: 1 << (((lo >>> 30) | (hi << 2)) & 0xF),
    cbp: (hi >>> 5) & 0x3FFF, cpsm: (hi >>> 19) & 0xF, csm: (hi >>> 23) & 1, csax: (hi >>> 24) & 1, csay: (hi >>> 25) & 0xF,
  };
}

/** Texture records of a TRI: [{tex, u, v, w, h (texels, fractional), gs: TEX0 fields}]. */
export function parseTri(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = o => dv.getUint32(o, true), f32 = o => dv.getFloat32(o, true);
  if (bytes.length < 0x40 || u32(0) !== 0) throw new Error('not a TRI');
  const count = u32(16), imageOff = u32(24), clutOff = u32(28);
  if (!count || count > 4096 || imageOff > bytes.length || clutOff > bytes.length) throw new Error('not a TRI');
  let padded = true;
  for (let k = 0; k < 8; k++) if (bytes.length >= 96 && u32(64 + 4 * k)) padded = false;
  const size = padded ? 0xC0 : 0xA0, t0 = padded ? 112 : 80;
  const out = [];
  for (let i = 0; i < count && 32 + (i + 1) * size <= bytes.length; i++) {
    const o = 32 + i * size, gs = tex0(u32(o + t0), u32(o + t0 + 4));
    out.push({ tex: u32(o + 16), u: f32(o) * gs.tw, v: f32(o + 4) * gs.th, w: f32(o + 8) * gs.tw, h: f32(o + 12) * gs.th, gs });
  }
  return out;
}

/** GS memory of one TRI, decoding GS textures (TW x TH RGBA) on demand. */
export class TriMemory {
  constructor(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.height = dv.getUint32(8, true); this.clutHeight = dv.getUint32(12, true);
    this.image = new Uint32Array(Math.max(2048, addr32(0, 1, 63, Math.max(0, this.height - 1)) + 2048));
    this.clut = new Uint32Array(Math.max(2048, addr32(0, 1, 63, Math.max(0, this.clutHeight - 1)) + 2048));
    write32(this.image, this.height, bytes, dv.getUint32(24, true));
    write32(this.clut, this.clutHeight, bytes, dv.getUint32(28, true));
  }
  /** RGBA of the whole TW x TH GS texture a record points at (null for formats other than T4 / T8). */
  decode(gs) {
    const bits = gs.psm === PSMT8 ? 8 : gs.psm === PSMT4 ? 4 : 0;
    if (!bits || gs.cpsm !== 0) return null;
    // CLUT: CT32 entries, 16 x 16 (T8) or 8 x 2 (T4) at CBP, offset by CSA
    const [cw, ch] = bits === 8 ? [16, 16] : [8, 2];
    let pal = [];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const a = addr32(gs.cbp, 1, gs.csax * 8 + x, gs.csay * 2 + y);
      pal.push(a < this.clut.length ? this.clut[a] : 0);
    }
    if (bits === 8 && !gs.csm) {          // CSM1: entries 8..15 and 16..23 of every 32 are swapped
      const p = pal.slice();
      for (let i = 1; i <= 29; i += 4) for (let k = 0; k < 8; k++) { p[i * 8 + k] = pal[(i + 1) * 8 + k]; p[(i + 1) * 8 + k] = pal[i * 8 + k]; }
      pal = p;
    }
    const rgba = new Uint8Array(pal.length * 4);
    pal.forEach((c, i) => {
      rgba[4 * i] = c & 0xFF; rgba[4 * i + 1] = (c >>> 8) & 0xFF; rgba[4 * i + 2] = (c >>> 16) & 0xFF;
      rgba[4 * i + 3] = Math.min(255, Math.round(((c >>> 24) & 0xFF) * 255 / 128));
    });
    const { tw, th } = gs, out = new Uint8Array(tw * th * 4), read = bits === 8 ? read8 : read4;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4, p = read(this.image, gs.tbp, gs.tbw, x, y) * 4;   // outside the data: index 0
      out[o] = rgba[p]; out[o + 1] = rgba[p + 1]; out[o + 2] = rgba[p + 2]; out[o + 3] = rgba[p + 3];
    }
    return out;
  }
}

/** Key a TRI texture is looked up by: texture hash and TRI hash (both 24-bit). */
export const triTexKey = (tex, tri) => tri * 0x1000000 + tex;
