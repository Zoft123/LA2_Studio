// Container formats around LA2 files and textures: DAR (file archive), QAR (resource pack), DLZ (compressed DLD).
import { Reader, Writer, latin1, concat } from '../core/bin.js';
import { inflateSync, deflateSync } from '../vendor/fflate.js';

// ---- DAR: u32 count; per file: name\0 padded to 4, u32 size, data aligned to 16, then one NUL --------------------
export function readDar(bytes) {
  let r = new Reader(bytes, true);
  let n = r.u32(0), le = true;
  if (n > 100000) { le = false; r = new Reader(bytes, false); n = r.u32(0); }
  const entries = [];
  let p = 4;
  for (let i = 0; i < n; i++) {
    let z = p;
    while (z < bytes.length && bytes[z] !== 0) z++;
    if (z >= bytes.length) throw new Error('DAR: truncated name');
    const name = latin1.decode(bytes.subarray(p, z));
    p = (z + 1 + 3) & ~3;
    const size = r.u32(p);
    p = (p + 4 + 15) & ~15;
    if (p + size > bytes.length) throw new Error('DAR: entry past end');
    entries.push({ name, offset: p, size });
    p += size + 1;
  }
  return { le, entries, end: p };
}

export function writeDar(files, le, trailer = new Uint8Array(0)) {
  const w = new Writer(le);
  w.u32(files.length);
  for (const { name, data } of files) {
    w.bytes(latin1.encode(name)).u8(0).align(4);
    w.u32(data.length).align(16);
    w.bytes(data).u8(0);
  }
  w.bytes(trailer);
  return w.result();
}

// ---- QAR: concatenated files, then {u16 count, u16 pad, count x (u32 info, u32 size)}, names; footer = header offset
export function readQar(bytes) {
  const r = new Reader(bytes, false);
  const hdr = r.u32(bytes.length - 4);
  const count = r.u16(hdr);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push([r.i32(hdr + 4 + i * 8), r.u32(hdr + 8 + i * 8)]);
  let p = hdr + 4 + count * 8;
  const out = [];
  let o = 0;
  for (let i = 0; i < count; i++) {
    let z = p;
    while (bytes[z] !== 0) z++;
    const name = latin1.decode(bytes.subarray(p, z));
    p = z + 1;
    const size = sizes[i][1];
    out.push({ name, data: bytes.subarray(o, o + size) });
    o += size;
  }
  return out;
}

// ---- DLZ: 'segs' segments of raw-deflate chunks -> DLD bytes ------------------------------------------------------
// segment {'segs', u16 4, u16 count, u32 total uncompressed, u32 serialized size (always LE)} + count x
// {u16 csize, u16 usize, u32 offset+1}; chunks of 0x4000 input bytes, 16-aligned; segments padded to 0x20000.
const CHUNK = 0x4000, SEGMENT = 0x20000;
const align = (v, a) => (v + a - 1) & ~(a - 1);

export function inflateDlz(bytes) {
  const parts = [];
  let pos = 0;
  while (pos + 16 <= bytes.length) {
    const be = bytes[pos] === 0x73 && bytes[pos + 1] === 0x65 && bytes[pos + 2] === 0x67 && bytes[pos + 3] === 0x73;
    const r = new Reader(bytes, !be);
    if (r.u32(pos) !== 0x73656773) {
      pos = pos % SEGMENT ? align(pos + 1, SEGMENT) : pos + SEGMENT;
      continue;
    }
    const count = r.u16(pos + 6);
    const csize = new Reader(bytes, true).u32(pos + 12);
    for (let i = 0; i < count; i++) {
      const c = r.u16(pos + 16 + i * 8), u = r.u16(pos + 18 + i * 8), off = r.u32(pos + 20 + i * 8);
      const chunk = bytes.subarray(pos + off - 1, pos + off - 1 + c);
      parts.push(c !== u ? inflateSync(chunk, { out: new Uint8Array(u) }) : chunk);
    }
    const next = pos + align(csize, SEGMENT);
    pos = next < bytes.length ? next : bytes.length;
  }
  return concat(parts);
}

/** DLD bytes -> DLZ in the game's own layout (le = PC/MGA header byte order). */
export function buildDlz(dld, le) {
  const chunks = [];
  for (let o = 0; o < dld.length; o += CHUNK) {
    const u = dld.subarray(o, o + CHUNK);
    let c = deflateSync(u, { level: 6 });
    if (c.length >= u.length) c = u;
    chunks.push([c, u.length]);
  }
  const out = [];
  let i = 0;
  while (i < chunks.length) {
    let n = 0;
    while (i + n < chunks.length) {
      let pos = align(16 + 8 * (n + 1), 16);
      for (const [c] of chunks.slice(i, i + n + 1)) pos = align(pos, 16) + c.length;
      if (align(pos, 16) > SEGMENT && n > 0) break;
      n++;
    }
    const seg = chunks.slice(i, i + n);
    let pos = align(16 + 8 * n, 16);
    const index = [];
    for (const [c, u] of seg) { pos = align(pos, 16); index.push([c.length, u, pos + 1]); pos += c.length; }
    const size = align(pos, 16);
    const s = new Uint8Array(size);
    const dv = new DataView(s.buffer);
    dv.setUint32(0, 0x73656773, le); dv.setUint16(4, 4, le); dv.setUint16(6, n, le);
    dv.setUint32(8, seg.reduce((a, [, u]) => a + u, 0), le);
    dv.setUint32(12, size, true);
    index.forEach(([cs, us, off], k) => {
      dv.setUint16(16 + 8 * k, cs, le); dv.setUint16(18 + 8 * k, us, le); dv.setUint32(20 + 8 * k, off, le);
      s.set(seg[k][0], off - 1);
    });
    i += n;
    const last = i >= chunks.length;
    const pad = (last ? 0x800 : SEGMENT) - (s.length % (last ? 0x800 : SEGMENT));
    out.push(s, new Uint8Array(pad % (last ? 0x800 : SEGMENT)));
  }
  return concat(out);
}
