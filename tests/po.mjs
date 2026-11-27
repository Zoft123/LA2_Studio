// Metal Gear Solid: Portable Ops (PSP) formats on small synthetic files: TXP texture packs (16-byte images with their
// own palettes, zlib-compressed or plain swizzled pixels, 48-byte textures), 0x80-aligned QARs, and LE version-8 LA2
// layouts that use them (TXP-qualified texture keys, UVs 0..65535 of the texture region).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writer, latin1, strcode } from '../js/core/bin.js';
import { parseTxp, decodeTxpImage, txpTexKey } from '../js/formats/txp.js';
import { readPwQar } from '../js/formats/archives.js';
import { TexturePool } from '../js/formats/textures.js';
import { zlibSync } from '../js/vendor/fflate.js';

const TEX = 0x123456;
/** IEEE-754 bits of a float32 (the Writer has no f32). */
const f32 = v => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true); };

/** PSP swizzle (16-byte x 8-row blocks) of linear rows. */
function swizzle(src, rowBytes, rows) {
  const out = new Uint8Array(src.length); let i = 0;
  for (let by = 0; by < rows; by += 8)
    for (let bx = 0; bx < rowBytes; bx += 16)
      for (let y = by; y < by + 8; y++, i += 16) out.set(src.subarray(y * rowBytes + bx, y * rowBytes + bx + 16), i);
  return out;
}

/** A Portable Ops TXP with one 32 x 8 4-bit image in a 32 x 16 buffer: pixel (x, y) = palette index (x + y) & 15,
 *  palette entry i = (16 i, 255 - 16 i, 0, 255). One texture: the whole visible image, texel-centred. */
function txp({ compressed }) {
  const W = 32, H = 8, rowBytes = W / 2;
  const linear = new Uint8Array(rowBytes * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) linear[y * rowBytes + (x >> 1)] |= ((x + y) & 15) << ((x & 1) * 4);
  let pixels = swizzle(linear, rowBytes, H);
  if (compressed) { const z = zlibSync(pixels); pixels = new Writer(true).u32(z.length).bytes(z).result(); }
  const palette = new Writer(true); for (let i = 0; i < 16; i++) palette.u8(16 * i).u8(255 - 16 * i).u8(0).u8(255);
  const pal = palette.result();
  const imgAt = 0x20, texAt = imgAt + 16, pixAt = texAt + 48, palAt = pixAt + pixels.length;
  const w = new Writer(true);
  w.u32(0).u32(0).u32(1).u32(imgAt).u32(1).u32(texAt).u32(0).u32(0);
  w.u16(5 << 12 | W).u16(4 << 12 | H).u16(4).u16(compressed ? 2 : 0).u32(pixAt).u32(palAt);      // 32 x 8 in 32 x 16
  w.u32(0x10).u32(TEX).u32(0).u16(W).u16(H).u32(0).u32(imgAt).u32(0)
    .u32(f32(0.5 / 32)).u32(f32(0.5 / 16)).u32(f32(31 / 32)).u32(f32(7 / 16)).u32(0);
  w.bytes(pixels).bytes(pal);
  return w.result();
}

for (const compressed of [false, true]) test(`TXP with ${compressed ? 'zlib-compressed' : 'plain'} swizzled pixels`, () => {
  const bytes = txp({ compressed }), name = strcode('lay_test_0');
  const t = parseTxp(bytes, name);
  assert.ok(t && t.psp);
  assert.equal(t.hash, name);
  const [tex] = t.textures;
  assert.equal(tex.hash, TEX);
  assert.deepEqual([tex.w, tex.h, tex.image.w, tex.image.h, tex.image.bw, tex.image.bh], [32, 8, 32, 8, 32, 16]);
  const img = decodeTxpImage(bytes, tex);
  assert.deepEqual([img.w, img.h], [32, 8]);
  for (const [x, y] of [[0, 0], [5, 3], [31, 7], [17, 2]]) {
    const i = (x + y) & 15, o = 4 * (y * 32 + x);
    assert.deepEqual([...img.rgba.subarray(o, o + 4)], [16 * i, 255 - 16 * i, 0, 255], `pixel ${x},${y}`);
  }
  // the pool keys it by (texture, TXP name hash); the region is in texels of the buffer (texel-centred)
  const pool = new TexturePool();
  assert.ok(pool.addTxp(bytes, name));
  const info = pool.info(txpTexKey(TEX, name));
  assert.deepEqual([info.u0, info.v0, info.uw, info.vh], [0.5, 0.5, 31, 7]);
  assert.ok(pool.raw(txpTexKey(TEX, name)));
  assert.equal(new TexturePool().addTxp(bytes), false, 'no name hash, no TXP hash');
});

test('QAR with files at 0x80 boundaries (Portable Ops)', () => {
  const a = txp({ compressed: false }), b = txp({ compressed: true }), names = ['a.txp', 'bb.txp'];
  const w = new Writer(true);
  for (const f of [a, b]) w.bytes(f).align(0x80);
  const toc = w.length;
  w.u32(2); [a, b].forEach((f, i) => w.u32(0x14000000 | strcode(names[i].replace('.txp', ''))).u32(f.length));
  for (const n of names) w.bytes(latin1.encode(n)).u8(0);
  w.u32(toc);
  const q = readPwQar(w.result());
  assert.ok(q);
  assert.deepEqual(q.map(e => [e.name, e.data.length]), [['a.txp', a.length], ['bb.txp', b.length]]);
  assert.deepEqual([...q[1].data.subarray(0, 32)], [...b.subarray(0, 32)]);
  assert.equal(q[1].id & 0xFFFFFF, strcode('bb'));
});
