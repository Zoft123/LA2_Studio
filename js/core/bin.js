// Binary helpers shared by every format module.

export class Reader {
  /** @param {Uint8Array} bytes @param {boolean} le little-endian */
  constructor(bytes, le) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.le = le;
  }
  u8(o) { return this.dv.getUint8(o); }
  u16(o) { return this.dv.getUint16(o, this.le); }
  i16(o) { return this.dv.getInt16(o, this.le); }
  u32(o) { return this.dv.getUint32(o, this.le); }
  i32(o) { return this.dv.getInt32(o, this.le); }
  f32(o) { return this.dv.getFloat32(o, this.le); }
  slice(o, n) { return this.b.subarray(o, o + n); }
  get length() { return this.b.length; }
}

/** Growable little/big-endian byte writer. */
export class Writer {
  constructor(le, size = 1 << 16) {
    this.le = le;
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
    this.n = 0;
  }
  _grow(k) {
    if (this.n + k <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.n + k) s *= 2;
    const nb = new Uint8Array(s);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v) { this._grow(1); this.dv.setUint8(this.n, v); this.n += 1; return this; }
  u16(v) { this._grow(2); this.dv.setUint16(this.n, v, this.le); this.n += 2; return this; }
  i16(v) { this._grow(2); this.dv.setInt16(this.n, v, this.le); this.n += 2; return this; }
  u32(v) { this._grow(4); this.dv.setUint32(this.n, v >>> 0, this.le); this.n += 4; return this; }
  bytes(a) { this._grow(a.length); this.buf.set(a, this.n); this.n += a.length; return this; }
  zeros(k) { this._grow(k); this.buf.fill(0, this.n, this.n + k); this.n += k; return this; }
  align(k) { const pad = (k - (this.n % k)) % k; return this.zeros(pad); }
  setU32(at, v) { this.dv.setUint32(at, v >>> 0, this.le); }
  setU16(at, v) { this.dv.setUint16(at, v, this.le); }
  get length() { return this.n; }
  result() { return this.buf.slice(0, this.n); }
}

/** Small endian-aware pack helper: pack(le, 'IHHhh', ...values) -> Uint8Array. */
export function pack(le, fmt, ...vals) {
  const w = new Writer(le, 64);
  let i = 0;
  for (const c of fmt) {
    const v = vals[i++];
    if (c === 'I') w.u32(v); else if (c === 'H') w.u16(v); else if (c === 'h') w.i16(v);
    else if (c === 'B') w.u8(v); else throw new Error('pack: ' + c);
  }
  return w.result();
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const latin1 = {
  decode: b => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; },
  encode: s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF; return b; },
};

export const hex = (v, n = 6) => (v >>> 0).toString(16).padStart(n, '0');
export const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const fromHex = s => {
  s = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};

/** MGS 24-bit string hash ("strcode") used for object, action, texture and command names. */
export function strcode(s) {
  let x = 0;
  for (const ch of latin1.encode(s)) {
    x = ((x << 5) | (x >>> 19)) & 0xFFFFFF;
    x = (x + ch) & 0xFFFFFF;
  }
  return x;
}
