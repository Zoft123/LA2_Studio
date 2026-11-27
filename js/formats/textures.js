// MGS4-engine textures: TXN tables (image + texture entries) and DLD data (texture pixels, usually from a DLZ).
import { Reader } from '../core/bin.js';
import { parseTri, TriMemory, triTexKey } from './tri.js';
import { parseCtxr, decodeCtxr, ctxrRegion } from './ctxr.js';
import { parseTxp, txpImageSize, decodeTxpImage, txpTexKey } from './txp.js';

export const FOURCC = { 9: 'DXT1', 10: 'DXT3', 11: 'DXT5' };
/** Pseudo format of already-decoded RGBA images (PS2 TRI textures). */
export const RGBA = 'RGBA';

/** TRI hashes are 24-bit; PS2 texture keys are tri << 24 | texture hash (see triTexKey). */
const HASH_RANGE = 0x1000000;

/** A PS3-port TRI whose image block is all zeros (its textures are CTXRs): its own pixels count as missing. */
function isStubTri(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const imageStart = view.getUint32(24, true);                            // TRI header: imageOffset
  const imageEnd = Math.min(bytes.length, view.getUint32(28, true));      // the CLUT block follows the image block
  if (!(imageStart < imageEnd)) return false;
  for (let i = imageStart; i < imageEnd; i++) if (bytes[i]) return false;
  return true;
}

/** Identifies the GS texture (and palette) a TRI record reads: records with equal keys share one decoded image. */
const gsImageKey = gs => [gs.tbp, gs.tbw, gs.psm, gs.tw, gs.th, gs.cbp, gs.csax, gs.csay, gs.csm].join(',');

/** TXN byte order: '<'-style little-endian for PC (MGA), big-endian for PS3 (MGS4 / MGO2). */
function txnLE(t) {
  for (const le of [true, false]) {
    const r = new Reader(t, le);
    if (t.length < 32) break;
    const nImg = r.u32(8), imgOff = r.u32(12), nInfo = r.u32(16), infoOff = r.u32(20);
    if (imgOff >= 0x20 && imgOff <= t.length && infoOff >= 0x20 && infoOff <= t.length && nImg < 4096 &&
        nInfo < 4096 && imgOff + 16 * nImg <= t.length && infoOff + 0x30 * nInfo <= t.length) return le;
  }
  return true;
}

/**
 * TXN: header {?, ?, u32 nImages, u32 imageOffset, u32 nInfos, u32 infoOffset, ...};
 * image {u16 w, u16 h, u16 fourcc, u16 flag, u32 dataOffset, u32 dataEnd} (data inside the TXN when there is no
 * DLZ, e.g. MGS4 slot_chibrowser); info (0x30 bytes) {flag, texture hash, tri hash, u16 w, h, ox, oy, u32 image,
 * ...}: a texture is a region (ox, oy, w, h) of an image.
 */
export function parseTxn(t) {
  const r = new Reader(t, txnLE(t));
  const nImg = r.u32(8), imgOff = r.u32(12), nInfo = r.u32(16), infoOff = r.u32(20);
  const images = new Map();
  for (let i = 0; i < nImg; i++) {
    const o = imgOff + i * 16;
    const w = r.u16(o), h = r.u16(o + 2), fourcc = r.u16(o + 4), off = r.u32(o + 8), end = r.u32(o + 12);
    images.set(o, { w, h, fourcc, index: i, embedded: off > 0 && off < end && end <= t.length ? [off, end] : null });
  }
  const infos = [];
  for (let i = 0; i < nInfo; i++) {
    const o = infoOff + i * 0x30;
    const img = images.get(r.u32(o + 20));
    infos.push({
      index: i, tex: r.u32(o + 4), tri: r.u32(o + 8), w: r.u16(o + 12), h: r.u16(o + 14), ox: r.u16(o + 16),
      oy: r.u16(o + 18), imgOff: r.u32(o + 20), img: img || null, imgIdx: img ? img.index : null,
    });
  }
  return infos;
}

function walkDld(d, le) {
  const r = new Reader(d, le);
  const out = new Map();
  let covered = 0, p = 0;
  while (p + 0x20 <= d.length) {
    p = (p + 15) & ~15;
    if (p + 0x20 > d.length) break;
    const typ = r.u8(p), prio = r.u8(p + 1), hid = r.u32(p + 8), size = r.u32(p + 16), entry = r.u32(p + 24);
    p += 0x20;
    if (size > d.length - p) break;
    if (typ) {
      out.set(hid + ':' + entry + ':' + prio, d.subarray(p, p + size));
      if (prio < 16 && entry < 0x10000) covered += 0x20 + size;
    }
    p += size;
  }
  return [out, covered];
}

/**
 * DLD: entries {u8 type, u8 priority, u8, u8, u32, u32 tri hash, u32, u32 size, u32 mips, u32 image index, u32}
 * then data. Byte order: whichever reading walks the file as a clean chain of entries (PS3 data is big-endian;
 * a field-size comparison is not enough, a 1 MB big-endian size reads as 4 KB little-endian).
 */
export function parseDld(d) {
  const a = walkDld(d, false), b = walkDld(d, true);
  return (a[1] > b[1] ? a : b)[0];
}

/** One stage's (or folder's) textures: TXN infos and DLD data, by texture hash. */
export class TexturePool {
  constructor() { this.infos = new Map(); this.data = new Map(); this.owners = null; this.remap = new Map(); }
  /** MGO2 DLC .dci: per TXN (TRI hash) and mip priority, (DLD image number, TXN image number) pairs. A patched TXN's
   *  images are read from the indexed DLZs (resident_d_013000.dlz, …) under these numbers, so a patch only ships the
   *  images that changed. Header {u32 hash, u32 0x1000, u32 count, u32 0}; record {u32 TRI, u32 table offset,
   *  u16 priority, u16 pairs}; table: pairs x {u16 dld image, u16 txn image (0xFFFF = unused)}. */
  addDci(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = v.getUint32(4, false) !== 0x1000;
    if (bytes.length < 16 || v.getUint32(4, le) !== 0x1000) return;
    const n = v.getUint32(8, le);
    for (let i = 0; i < n && 16 + 12 * i + 12 <= bytes.length; i++) {
      const o = 16 + 12 * i, tri = v.getUint32(o, le), at = v.getUint32(o + 4, le), prio = v.getUint16(o + 8, le), cnt = v.getUint16(o + 10, le);
      if (at === 1 || at + 4 * cnt > bytes.length) continue;
      const m = new Map();
      for (let k = 0; k < cnt; k++) {
        const dld = v.getUint16(at + 4 * k, le), img = v.getUint16(at + 4 * k + 2, le);
        if (img !== 0xFFFF) m.set(img, dld);
      }
      this.remap.set(tri + ':' + prio, m);
    }
  }
  addTxn(bytes) {
    for (const info of parseTxn(bytes)) {
      if (info.img && info.img.embedded) info.txn = bytes;
      if (!this.infos.has(info.tex)) this.infos.set(info.tex, info);
    }
    this.owners = null;
  }
  addDld(bytes) { for (const [k, v] of parseDld(bytes)) this.data.set(k, v); }
  /** PS2 TRI (MGS3 / MGO1): its textures under triTexKey(texture, TRI); each is a region of a GS texture decoded
   *  on first use and shared by the regions that point at the same GS texture (same TEX0).
   *  `hd` (texture hash -> CTXR source) marks the PS3 port's HD replacements; load them with setHd().
   *
   *  PS2 infos have the TXN info fields (index, tex, tri, w, h, ox, oy, imgOff, img, imgIdx) plus:
   *  ps2  the TRI they come from ({bytes, memory: TriMemory once decoded, images: decoded GS textures, stub})
   *  gs   TEX0 fields; imgOff is gsImageKey(gs) (or 'ctxr:<hash>' once a CTXR replaces the image)
   *  u0, v0, uw, vh  the texture's rectangle in its image (fractional texels; layout UVs are 0..65535 of it)
   *  rec  the TRI record; hdSrc  the CTXR source to load (null: none), hd  its bytes once loaded. */
  addTri(bytes, triHash, hd = null) {
    const tri = { bytes, memory: null, images: new Map(), stub: isStubTri(bytes) };
    for (const rec of parseTri(bytes)) {
      const gs = rec.gs;
      const key = triTexKey(rec.tex, triHash);
      if (this.infos.has(key)) continue;
      this.infos.set(key, {
        index: this.infos.size, tex: rec.tex, tri: triHash, ps2: tri, gs, imgOff: gsImageKey(gs),
        // whole texels covered by the region (for the texture list and PNG export)
        w: Math.max(1, Math.round(rec.w)), h: Math.max(1, Math.round(rec.h)),
        ox: Math.max(0, Math.floor(rec.u)), oy: Math.max(0, Math.floor(rec.v)),
        u0: rec.u, v0: rec.v, uw: rec.w, vh: rec.h,
        img: { w: gs.tw, h: gs.th, fourcc: RGBA }, imgIdx: null,
        rec, hdSrc: hd?.get(rec.tex) ?? null, hd: null,
      });
    }
    this.bytes = (this.bytes || 0) + bytes.length;
  }

  /** Texture info by key; in the PS3 port also a texture whose TRI is not in the folder but whose CTXR is (the game
   *  finds CTXRs by texture hash): it gets an info of its own, with the whole CTXR as its region. */
  info(key) {
    let info = this.infos.get(key);
    if (info || key < HASH_RANGE) return info;                 // known, or not a PS2 (TRI-qualified) key
    const tex = key % HASH_RANGE, source = this.hd?.get(tex);
    if (source) {
      info = {
        index: this.infos.size, tex, tri: Math.floor(key / HASH_RANGE), ps2: null, gs: null, imgOff: 'ctxr:' + tex,
        w: 1, h: 1, ox: 0, oy: 0, u0: 0, v0: 0, uw: 1, vh: 1, img: { w: 1, h: 1, fourcc: RGBA }, imgIdx: null,
        rec: { u: 0, v: 0, w: 0, h: 0 },                         // empty region: ctxrRegion uses the whole image
        hdSrc: source, hd: null,
      };
      this.infos.set(key, info);
    }
    return info;
  }

  /** Peace Walker TXP: its textures under txpTexKey(texture, TXP). Texture rectangles use the TXP image's
   *  power-of-two buffer dimensions. A PS3 DDS can contain extra padding; that padding does not scale the UVs
   *  (PS3 EBOOT 2D6F8 -> C51020 -> C2018C -> C20F60). Images decode on first use. */
  addTxp(bytes, nameHash = null) {
    const txp = parseTxp(bytes, nameHash);       // nameHash: Portable Ops TXPs have no hash of their own
    if (!txp || txp.hash === null) return false;
    for (const t of txp.textures) {
      const key = txpTexKey(t.hash, txp.hash);
      if (this.infos.has(key)) continue;
      const size = txpImageSize(bytes, t);
      const W = size ? size.w : 1, H = size ? size.h : 1;
      const BW = t.image ? t.image.bw : W, BH = t.image ? t.image.bh : H;
      const u0 = t.u * BW, v0 = t.v * BH, uw = t.uw * BW, vh = t.vh * BH;
      this.infos.set(key, {
        index: this.infos.size, tex: t.hash, tri: txp.hash, txp: { bytes, tex: t, available: !!size },
        // the same pixels with another palette decode differently
        imgOff: `txp:${t.image ? t.image.offset : -1}:${t.palette}`,
        w: Math.max(1, Math.round(uw)), h: Math.max(1, Math.round(vh)), ox: Math.floor(u0), oy: Math.floor(v0),
        u0, v0, uw, vh, lw: t.w || 1, lh: t.h || 1,
        img: { w: W, h: H, fourcc: RGBA }, imgIdx: null,
      });
    }
    this.bytes = (this.bytes || 0) + bytes.length;
    return true;
  }

  /** Use a PS3-port CTXR as a TRI texture's image: the CTXR redraws the texture's region at its own size. */
  setHd(info, bytes) {
    const header = parseCtxr(bytes);
    if (!header) { info.hdSrc = null; return false; }
    Object.assign(info, ctxrRegion(info.rec, header.w, header.h), {
      hd: bytes, w: header.w, h: header.h, ox: 0, oy: 0, imgOff: 'ctxr:' + info.tex,
      img: { w: header.w, h: header.h, fourcc: RGBA },
    });
    this.bytes = (this.bytes || 0) + bytes.length;
    return true;
  }

  /** {w, h, fourcc, data} of a texture's full image (top mip) or null; no decoding. */
  raw(h) {
    const info = this.infos.get(h);
    if (!info || !info.img) return null;
    const { w, h: ih, fourcc } = info.img;
    if (info.txp) {                                            // Peace Walker TXP: decoded once, cached on the info
      if (!info.txp.available) return null;
      if (info.txpRgba === undefined) info.txpRgba = decodeTxpImage(info.txp.bytes, info.txp.tex)?.rgba || null;
      return info.txpRgba ? { w, h: ih, fourcc, data: info.txpRgba } : null;
    }
    if (info.hd) {                                             // PS3 port: decoded CTXR, cached on the info
      if (info.hdRgba === undefined) info.hdRgba = decodeCtxr(info.hd)?.rgba || null;
      return info.hdRgba ? { w, h: ih, fourcc, data: info.hdRgba } : null;
    }
    if (info.hdSrc !== undefined && !info.ps2) return null;   // CTXR-only texture, not loaded (or unreadable)
    if (fourcc === RGBA) {                                     // PS2: decode the GS texture once per TRI
      const tri = info.ps2;
      if (tri.stub) return null;
      if (!tri.images.has(info.imgOff)) {
        tri.memory = tri.memory || new TriMemory(tri.bytes);
        tri.images.set(info.imgOff, tri.memory.decode(info.gs));
      }
      const data = tri.images.get(info.imgOff);
      return data ? { w, h: ih, fourcc, data } : null;
    }
    if (!FOURCC[fourcc]) return null;
    const need = Math.max(1, (w + 3) >> 2) * Math.max(1, (ih + 3) >> 2) * (fourcc === 9 ? 8 : 16);
    if (!this.owners) {   // atlases: several TXN entries share one image; its data is stored under one index
      this.owners = new Map();
      for (const i of this.infos.values()) {
        const k = i.tri + ':' + i.imgOff;
        if (!this.owners.has(k)) this.owners.set(k, []);
        this.owners.get(k).push(i.index);
      }
    }
    const cands = [...(info.imgIdx !== null ? [info.imgIdx] : []), info.index, ...(this.owners.get(info.tri + ':' + info.imgOff) || [])];
    for (const idx of cands) {
      // a TXN with .dci remaps only uses remapped numbers (its raw numbers name other images in the indexed DLZs)
      const remapped = [0, 1, 2, 3].some(p => this.remap.has(info.tri + ':' + p));
      for (const prio of [0, 3, 1, 2]) {
        const rm = this.remap.get(info.tri + ':' + prio);
        if (remapped && !(rm && rm.has(idx))) continue;
        const dld = rm ? rm.get(idx) : idx;
        const d = this.data.get(info.tri + ':' + dld + ':' + prio);
        if (d && d.length >= need) return { w, h: ih, fourcc, data: d.subarray(0, need) };
      }
    }
    if (info.txn && info.img.embedded) {
      const [off, end] = info.img.embedded;
      if (end - off >= need) return { w, h: ih, fourcc, data: info.txn.subarray(off, off + need) };
    }
    return null;
  }
}

// ---- DXT decoding ---------------------------------------------------------------------------------------------
function rgb565(c, out, o) {
  out[o] = ((c >> 11) & 31) * 255 / 31 + 0.5 | 0;
  out[o + 1] = ((c >> 5) & 63) * 255 / 63 + 0.5 | 0;
  out[o + 2] = (c & 31) * 255 / 31 + 0.5 | 0;
}

/** DXT1/3/5 blocks (little-endian, as in DDS) -> RGBA8 pixels. */
export function decodeDxt(w, h, fourcc, data) {
  const out = new Uint8Array(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const bs = fourcc === 9 ? 8 : 16;
  const pal = new Uint8Array(16), alpha = new Uint8Array(16);
  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, p += bs) {
      let cp = p;
      if (fourcc === 10) {        // DXT3: 4-bit explicit alpha
        for (let i = 0; i < 8; i++) { alpha[2 * i] = (data[p + i] & 15) * 17; alpha[2 * i + 1] = (data[p + i] >> 4) * 17; }
        cp = p + 8;
      } else if (fourcc === 11) { // DXT5: interpolated alpha
        const a0 = data[p], a1 = data[p + 1];
        const av = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) av.push(((7 - i) * a0 + i * a1) / 7 + 0.5 | 0);
        else { for (let i = 1; i < 5; i++) av.push(((5 - i) * a0 + i * a1) / 5 + 0.5 | 0); av.push(0, 255); }
        let bits = 0, nb = 0, k = 0;
        for (let i = 2; i < 8; i++) {
          bits |= data[p + i] << nb; nb += 8;
          while (nb >= 3 && k < 16) { alpha[k++] = av[bits & 7]; bits >>= 3; nb -= 3; }
        }
        cp = p + 8;
      }
      const c0 = data[cp] | (data[cp + 1] << 8), c1 = data[cp + 2] | (data[cp + 3] << 8);
      rgb565(c0, pal, 0); rgb565(c1, pal, 4);
      pal[3] = pal[7] = 255;
      if (c0 > c1 || fourcc !== 9) {
        for (let i = 0; i < 3; i++) { pal[8 + i] = (2 * pal[i] + pal[4 + i]) / 3 + 0.5 | 0; pal[12 + i] = (pal[i] + 2 * pal[4 + i]) / 3 + 0.5 | 0; }
        pal[11] = pal[15] = 255;
      } else {
        for (let i = 0; i < 3; i++) { pal[8 + i] = (pal[i] + pal[4 + i]) >> 1; pal[12 + i] = 0; }
        pal[11] = 255; pal[15] = 0;
      }
      const idx = data[cp + 4] | (data[cp + 5] << 8) | (data[cp + 6] << 16) | (data[cp + 7] << 24);
      for (let k = 0; k < 16; k++) {
        const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
        if (x >= w || y >= h) continue;
        const ci = (idx >>> (2 * k)) & 3, o = (y * w + x) * 4;
        out[o] = pal[ci * 4]; out[o + 1] = pal[ci * 4 + 1]; out[o + 2] = pal[ci * 4 + 2];
        out[o + 3] = fourcc === 9 ? pal[ci * 4 + 3] : alpha[k];
      }
    }
  }
  return out;
}

/** Block byte sizes of each mip level (DXT1 8 bytes per 4x4 block, DXT3/5 16). */
export function levelSizes(w, h, fourcc, count = 16) {
  const bs = fourcc === 9 ? 8 : 16, out = [];
  for (let k = 0; k < count; k++) {
    const lw = Math.max(1, w >> k), lh = Math.max(1, h >> k);
    out.push(Math.max(1, (lw + 3) >> 2) * Math.max(1, (lh + 3) >> 2) * bs);
    if (lw === 1 && lh === 1) break;
  }
  return out;
}

/** DLD entries holding image `imgIdx` of TRI `tri` (with their priority and mip mask), for texture replacement. */
export function dldLE(dld) { return walkDld(dld, true)[1] >= walkDld(dld, false)[1]; }

export function dldEntries(dld, tri, imgIdx) {
  const r = new Reader(dld, dldLE(dld)), out = [];
  let p = 0;
  while (p + 0x20 <= dld.length) {
    p = (p + 15) & ~15;
    if (p + 0x20 > dld.length) break;
    const typ = r.u8(p), prio = r.u8(p + 1), hid = r.u32(p + 8), psize = r.u32(p + 12), size = r.u32(p + 16);
    const mips = r.u32(p + 20), entry = r.u32(p + 24);
    if (size > dld.length - p - 0x20) break;
    if (typ && hid === tri && entry === imgIdx) out.push({ offset: p + 0x20, size, prio, mips, psize });
    p += 0x20 + size;
  }
  return out;
}
