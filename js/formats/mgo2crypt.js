// Metal Gear Online 2 (PS3) stage-file encryption ("ptsys"), as implemented by HavenStudio2's PtsysCrypto /
// CryptoService (see README credits). The key is the file's folder below USRDIR/o, e.g.
// "stage/r_sna01_n"; both USRDIR/o/stage/<name> and USRDIR/o/dl/p/stage/<name> use "stage/<name>".
//
// file = 64-bit XOR chain over the data, then a 16-byte trailer: MD5(saltB + MD5(saltA + encrypted body)).
// FILES_KEY is HavenStudio2's file key already unwrapped with its base key (one Blowfish-CBC decryption).

const FILES_KEY = hexBytes(
  '5db9c260dcde6397dde2487e08ed5e93b7052bb190a9f6749f5eae699c168697' +
  'd0c85a21c732dfa1bb5cedc93ed4b7971b99dc1c45300afc415c591ca150de52');

function hexBytes(s) {
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.substr(2 * i, 2), 16);
  return b;
}

// ---- MD5 (RFC 1321) -------------------------------------------------------------------------------------------
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(...chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const total = ((len + 8) >> 6) + 1 << 6;
  const m = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { m.set(c, o); o += c.length; }
  m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, (len * 8) >>> 0, true);
  dv.setUint32(total - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let blk = 0; blk < total; blk += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(blk + 4 * i, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(4 * i, v, true));
  return out;
}

// ---- key schedule ---------------------------------------------------------------------------------------------
const cache = new Map();

function init(folder) {
  if (cache.has(folder)) return cache.get(folder);
  const fh = md5(new TextEncoder().encode(folder));
  const derived = new Uint8Array(64);
  for (let i = 0; i < 64; i++) derived[i] = FILES_KEY[i] ^ fh[i % 16];
  const saltA = derived.map(b => b ^ 0x36), saltB = derived.map(b => b ^ 0x5C);
  // eight little-endian u64 words as [lo, hi] u32 pairs
  const dv = new DataView(derived.buffer);
  const key = [];
  for (let i = 0; i < 8; i++) key.push([dv.getUint32(8 * i, true), dv.getUint32(8 * i + 4, true)]);
  const r = { key, saltA, saltB };
  cache.set(folder, r);
  return r;
}

/** True if `data` carries the ptsys checksum trailer for this folder key (it is encrypted with that key). */
export function checksumOk(data, folder) {
  if (data.length < 0x18) return false;
  const { saltA, saltB } = init(folder);
  const h1 = md5(saltA, data.subarray(0, data.length - 16));
  const h2 = md5(saltB, h1);
  for (let i = 0; i < 16; i++) if (h2[i] !== data[data.length - 16 + i]) return false;
  return true;
}

/** plain_i = c_i ^ c_(i-1) ^ K[(i % 7) + 1], c_(-1) = K[0]; output drops the 0x18-byte tail. */
export function decrypt(data, folder) {
  const { key } = init(folder);
  const size = data.length - 0x10;
  const n = Math.max(0, Math.floor(size / 8));
  const buf = new Uint8Array(n * 8);
  buf.set(data.subarray(0, n * 8));
  const w = new Uint32Array(buf.buffer);            // platform order: little-endian on every browser target
  let plo = key[0][0], phi = key[0][1];
  for (let i = 0; i < n; i++) {
    const clo = w[2 * i], chi = w[2 * i + 1];
    const k = key[(i % 7) + 1];
    w[2 * i] = clo ^ plo ^ k[0];
    w[2 * i + 1] = chi ^ phi ^ k[1];
    plo = clo; phi = chi;
  }
  const out = new Uint8Array(Math.max(0, data.length - 0x18));
  out.set(buf.subarray(0, Math.min(buf.length, out.length)));
  if (out.length > buf.length) out.set(data.subarray(buf.length, out.length), buf.length);
  return out;
}

/** Inverse of decrypt: pads, chains, appends the checksum trailer. */
export function encrypt(plain, folder) {
  const { key, saltA, saltB } = init(folder);
  let size = plain.length;
  const buf = new Uint8Array(size + 0x18 + 8);
  buf.set(plain);
  const rem = size % 8, pad = 8 - rem;
  const endBytes = plain.slice(size - rem, size);
  for (let i = 0; i < pad; i++) buf[size + i] = pad;
  size += pad;
  const n = (size + 0x10) >> 3;
  const w = new Uint32Array(buf.buffer, 0, n * 2);
  let plo = key[0][0], phi = key[0][1];
  for (let i = 0; i < n; i++) {
    const k = key[(i % 7) + 1];
    plo = w[2 * i] ^ k[0] ^ plo;
    phi = w[2 * i + 1] ^ k[1] ^ phi;
    w[2 * i] = plo; w[2 * i + 1] = phi;
  }
  buf.set(endBytes, size);
  size += rem;
  const h2 = md5(saltB, md5(saltA, buf.subarray(0, size)));
  buf.set(h2, size);
  return buf.slice(0, size + 16);
}

/** "stage/<name>" for a path that has a stage/<name>/ component, else null. */
export function keyForPath(path) {
  const parts = path.split('/').filter(Boolean);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'stage' && i + 1 < parts.length - 1) return 'stage/' + parts[i + 1];
  }
  return null;
}
