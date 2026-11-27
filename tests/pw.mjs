// Peace Walker (PS3 HD) formats: LA3 layouts, TXP texture packs and PW QAR archives, on small synthetic files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writer, latin1 } from '../js/core/bin.js';
import { parseLa3, openLa3, isLa3 } from '../js/formats/la3.js';
import { parseTxp, decodeTxpImage, txpTexKey } from '../js/formats/txp.js';
import { readPwQar } from '../js/formats/archives.js';
import { TexturePool } from '../js/formats/textures.js';
import { Scene, Timeline } from '../js/engine/scene.js';

const TEX = 0x111111, TXP = 0x222222;
const NUL = 0, SPRT = 3, STRING = 10;

/** An LA3 file from its sections: [type, bytes] in order. */
function la3(sections, version = 7) {
  const w = new Writer(true);
  w.bytes(latin1.encode('FEL')).u8(version).u32(0).u16(0).u16(0x0404).u32(300);
  for (const [type, bytes] of sections) w.u8(type).u8(bytes.length & 0xFF).u8((bytes.length >> 8) & 0xFF).u8(bytes.length >> 16).bytes(bytes);
  w.u32(0);
  return w.result();
}
const le = build => { const w = new Writer(true); build(w); return w.result(); };
/** Object record: id, parent, hash, type, {bit: value}. */
const object = (id, parent, hash, type, values) => le(w => {
  const bits = Object.keys(values).map(Number).sort((a, b) => a - b);
  w.u16(id).u16(parent).u32(hash).u32(type | 0x3FE0).u32(bits.reduce((m, b) => m | (1 << b), 0)).u32(0);
  for (const b of bits) w.i16(values[b]);
  w.align(4);
});

/** A Nul with a red textured Sprt and a two-letter String under it, and one action moving the Nul. */
function sample(str = 'AA', version = 7) {
  // point lists: 0 Nul position, 1 Sprt position, 2 Sprt size, 3 Sprt UV, 4 morph target, 5 glyph size, 6 glyph UV
  const lists = [[[160, 80]], [[0, 0]], [[320, 160]], [[0, 0], [256, 128]], [[320, 80]], [[96, 192]], [[16, 0], [112, 192]]];
  const points = lists.flat();
  let first = 0;
  const s90 = le(w => { w.u16(lists.length).u16(points.length); for (const l of lists) { w.u8(l.length).u8(0).u16(first); first += l.length; } });
  const s91 = le(w => { for (const [x, y] of points) w.i16(x).i16(y); });
  const sA0 = le(w => w.u16(1).u16(1).u16(1).u16(0));
  const sA1 = Uint8Array.of(255, 0, 0, 0x80);
  const s80 = le(w => w.u16(1).u16(2).u8(0).u8(1).u16(0));    // texture 0 = hash 0 (TEX) in TXP hash 1 (TXP)
  const s81 = le(w => w.u32(TEX).u32(TXP));
  const text = latin1.encode(str);
  const sC0 = le(w => w.u16(1).u16(1).u16(text.length).u16(0));
  const sD0 = le(w => w.u16(1).u16(1).u32(0xF0F0F0).u16(1).u16(0));
  const sD1 = le(w => w.u16(1).u16(0).u32(str.charCodeAt(0)).u16(5).u16(6));
  const objs = [
    object(0, 0xFFFF, 0xA00001, NUL, { 2: 1, 4: 0, 17: 256 }),
    object(1, 0, 0xA00002, SPRT, { 2: 1, 4: 1, 5: 0, 6: 2, 7: 3, 19: 0 }),
    object(2, 0, 0xA00003, STRING, { 2: 1, 4: 1, 6: 2, 11: 0, 19: 0, 22: 0, 23: 0 }),
  ];
  const s20 = le(w => { w.u16(objs.length).u16(0); let o = 0; for (const b of objs) { w.u16(o); o += b.length; } w.align(4); });
  const s21 = le(w => objs.forEach(b => w.bytes(b)));
  // one action record (group 0xABCDEF, track 1) on the Nul: morph to point list 4 over 30 ticks, then end
  const keys = [le(w => w.u16(2).u16(16).u32(30).u32(1 << 4).i16(4).u16(0)), le(w => w.u16(0).u16(4))];
  const s50 = le(w => { w.u16(keys.length).u16(0); let o = 0; for (const k of keys) { w.u32(o); o += k.length; } });
  const s51 = le(w => keys.forEach(k => w.bytes(k)));
  const s40 = le(w => w.u16(1).u16(16).u32(0x01ABCDEF).u32(0xA00001).u32(30).u16(2).u16(0));
  const s41 = le(w => w.u16(0).u16(1));
  return la3([[0x80, s80], [0x81, s81], [0xC0, sC0], [0xC1, text], [0x90, s90], [0x91, s91], [0xA0, sA0], [0xA1, sA1],
    [0xD0, sD0], [0xD1, sD1], [0x50, s50], [0x51, s51], [0x40, s40], [0x41, s41], [0x20, s20], [0x21, s21]], version);
}

/** PSP swizzle (16-byte x 8-row blocks), the inverse of what decodeTxpImage undoes. */
function swizzle(src, rowBytes, rows) {
  const out = new Uint8Array(src.length);
  let i = 0;
  for (let by = 0; by < rows; by += 8) for (let bx = 0; bx < rowBytes; bx += 16)
    for (let y = by; y < by + 8; y++, i += 16) out.set(src.subarray(y * rowBytes + bx, y * rowBytes + bx + 16), i);
  return out;
}
/** A one-texture TXP: 64 x 16, 4-bit indices (index = x / 4), 16-colour palette (colour k = [k, 2k, 3k, 255]). */
function sampleTxp() {
  const W = 64, H = 16, rowBytes = W / 2;
  const linear = new Uint8Array(rowBytes * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x += 2) linear[y * rowBytes + x / 2] = ((x >> 2) & 15) | (((x + 1) >> 2 & 15) << 4);
  const pixels = swizzle(linear, rowBytes, H);
  const imgTable = 0x20, texTable = imgTable + 20, pal = texTable + 40, px = pal + 64;
  return le(w => {
    w.u32(0).u32(TXP).u32(1).u32(1).u32(0).u32(imgTable).u32(texTable).u32(pal);
    w.u16(4).u16((6 << 12) | W).u16((4 << 12) | H).u16(0).u32(0).u32(px).u32(0);
    w.u32(0x10000).u32(TEX).u32(imgTable).u32(pal);
    for (const f of [0.25, 0, 0.5, 1]) w.bytes(new Uint8Array(new Float32Array([f]).buffer));
    w.u16(32).u16(16).u32(0);
    for (let k = 0; k < 16; k++) w.u8(k).u8(2 * k).u8(3 * k).u8(255);
    w.bytes(pixels);
  });
}

test('LA3: objects, lists, colours, textures, texts and fonts are read', () => {
  const bytes = sample();
  assert.ok(isLa3(bytes));
  const L = parseLa3(bytes);
  assert.equal(L.objects.length, 3);
  assert.deepEqual([...L.objects[1].values], [[2, 1], [4, 1], [5, 0], [6, 2], [7, 3], [19, 0]]);
  assert.deepEqual(L.textures, [{ tex: TEX, txp: TXP }]);
  assert.deepEqual(L.colors, [[[255, 0, 0, 0x80]]]);
  assert.equal(latin1.decode(L.texts[0]), 'AA');
  assert.deepEqual(L.fonts[0].glyphs.get('A'), [96, 192, 16, 112, 0, 192]);
  assert.equal(L.tracks[0].keys.length, 2);
  assert.equal(L.keys[0].ticks, 30);
});

test('LA3 opens as a view-only LA2 model whose actions play', () => {
  const la = openLa3(sample());
  assert.ok(la.la3);
  assert.deepEqual(la.objects.map(o => [o.id, o.parent, o.type]), [[1, 0, NUL], [2, 1, SPRT], [3, 1, STRING]]);
  assert.deepEqual(la.texKeys, [txpTexKey(TEX, TXP)]);
  assert.equal(la.actions.length, 1);
  assert.equal(la.actionHash.get(0), 0xABCDEF);
  const scene = new Scene(la, null);
  const tl = new Timeline(la, 0, 'once');
  scene.setTimeline(tl);
  assert.equal(tl.length(), 30);
  scene.seek(30);
  assert.deepEqual(scene.state.get(1).xy, [[[320, 80]]]);
});

test('LA3 v4/v5: layouts, fonts and action tracks open; data after the end chunk is ignored', () => {
  for (const version of [4, 5]) {
    const bytes = sample('AA', version), withTrailer = new Uint8Array(bytes.length + 12);
    withTrailer.set(bytes);
    withTrailer.fill(0xCD, bytes.length);
    const la = openLa3(withTrailer);
    assert.equal(la.la3.version, version);
    assert.deepEqual(la.fonts[0].glyphs.get('A'), [96, 192, 16, 112, 0, 192]);
    const scene = new Scene(la, null), tl = new Timeline(la, 0, 'once');
    scene.setTimeline(tl);
    scene.seek(30);
    assert.deepEqual(scene.state.get(1).xy, [[[320, 80]]]);
  }
});

test('LA3 versioned point lists: v4/v5 have 16-bit counts, v7 has a 24-bit first point', () => {
  for (const version of [4, 5]) {
    const n = 300;
    const s90 = le(w => w.u16(1).u16(n).u16(n).u16(0));
    const s91 = le(w => { for (let k = 0; k < n; k++) w.i16(k).i16(-k); });
    const L = parseLa3(la3([[0x90, s90], [0x91, s91]], version));
    assert.equal(L.lists[0].length, n);
    assert.deepEqual(L.lists[0].at(-1), [n - 1, 1 - n]);
  }
  const first = 0x10001;
  const s90 = le(w => w.u16(1).u16(0).u8(1).u8(1).u16(1));
  const s91 = le(w => w.zeros(first * 4).i16(321).i16(-123));
  assert.deepEqual(parseLa3(la3([[0x90, s90], [0x91, s91]])).lists, [[[321, -123]]]);
});

test('LA3 v4/v5 retain byte texture indices even with a large hash table', () => {
  const s80 = le(w => w.u16(1).u16(256).u8(1).u8(2).u16(0));
  const s81 = le(w => { for (let k = 0; k < 256; k++) w.u32(0x100000 + k); });
  for (const version of [4, 5]) {
    assert.deepEqual(parseLa3(la3([[0x80, s80], [0x81, s81]], version)).textures,
      [{ tex: 0x100001, txp: 0x100002 }]);
  }
});

test('LA3 unverified versions remain rejected', () => {
  for (const version of [0, 1, 2, 3, 6, 8, 255]) {
    assert.throws(() => parseLa3(la3([], version)), /not supported/);
  }
});

test('LA3 sprite and glyph UVs are 1/16 texel of the texture, scaled onto its image', () => {
  const pool = new TexturePool();
  assert.ok(pool.addTxp(sampleTxp()));
  const key = txpTexKey(TEX, TXP), info = pool.info(key);
  // texture = the right half of a 64 x 16 image, laid out as 32 x 16 units
  assert.deepEqual([info.u0, info.v0, info.uw, info.vh, info.lw, info.lh], [16, 0, 32, 16, 32, 16]);
  const tx = { lookup: h => h === key ? { ...info, iw: 64, ih: 16 } : null };
  const scene = new Scene(openLa3(sample()), tx);
  const prims = scene.primitives();
  const sprite = prims.find(p => p.id === 2), glyphs = prims.filter(p => p.id === 3);
  assert.deepEqual(sprite.pts, [[10, 5], [30, 5], [30, 15], [10, 15]]);           // Nul (10, 5) + 320 x 160 / 16
  assert.deepEqual(sprite.uv, [[16, 0], [32, 0], [32, 8], [16, 8]]);              // 0..256 x 0..128 / 16 texels
  assert.deepEqual(sprite.cols[0], [1, 0, 0, 1]);
  assert.equal(glyphs.length, 2);                                                  // 'AA', 6 px apart
  assert.deepEqual(glyphs[1].pts[0], [16, 5]);
  assert.deepEqual(glyphs[0].uv, [[17, 0], [23, 0], [23, 12], [17, 12]]);
});

test('LA3 placeholder text ("@@") is hidden unless asked for', () => {
  const tx = { lookup: () => ({ u0: 0, v0: 0, uw: 64, vh: 16, lw: 64, lh: 16, w: 64, h: 16, ox: 0, oy: 0 }) };
  const scene = new Scene(openLa3(sample('@@')), tx);
  assert.equal(scene.primitives().filter(p => p.id === 3).length, 0);
  scene.showPlaceholders = true;
  assert.equal(scene.primitives().filter(p => p.id === 3).length, 2);
});

test('TXP: PSP-swizzled 4-bit images decode through their palette', () => {
  const bytes = sampleTxp(), txp = parseTxp(bytes);
  assert.equal(txp.hash, TXP);
  const t = txp.textures[0], img = decodeTxpImage(bytes, t);
  assert.deepEqual([img.w, img.h], [64, 16]);
  for (const [x, y] of [[0, 0], [5, 3], [37, 9], [63, 15]]) {
    const k = (x >> 2) & 15, o = (y * 64 + x) * 4;
    assert.deepEqual([...img.rgba.subarray(o, o + 4)], [k, 2 * k, 3 * k, 255], `${x},${y}`);
  }
});

test('TXP DDS padding preserves buffer coordinates for sprites and font glyphs', () => {
  // Like the PS3 font atlases: the source buffer is 64x16, but the stored DDS is 64x128.
  // Scaling by the DDS height would incorrectly multiply every glyph's V coordinate by eight.
  const bytes = le(w => {
    const img = 0x20, tex = img + 20, dds = tex + 40;
    w.u32(1).u32(TXP).u32(1).u32(1).u32(0).u32(img).u32(tex).u32(dds);
    w.u16(6).u16((6 << 12) | 64).u16((4 << 12) | 128).u16(0).u32(0).u32(dds).u32(0);
    w.u32(0x1000).u32(TEX).u32(img).u32(dds);
    for (const f of [0.25, 0.25, 0.5, 0.5]) w.bytes(new Uint8Array(new Float32Array([f]).buffer));
    w.u16(32).u16(8).u32(0);
    w.zeros(128 + 64 * 128 * 4);
    w.setU32(dds, 0x20534444); w.setU32(dds + 4, 124);
    w.setU32(dds + 12, 128); w.setU32(dds + 16, 64);
    w.setU32(dds + 80, 0x40); w.setU32(dds + 88, 32);
    w.setU32(dds + 92, 0xFF); w.setU32(dds + 96, 0xFF00);
    w.setU32(dds + 100, 0xFF0000); w.setU32(dds + 104, 0xFF000000);
  });
  const pool = new TexturePool();
  assert.ok(pool.addTxp(bytes));
  const k = txpTexKey(TEX, TXP), i = pool.info(k), raw = pool.raw(k);
  assert.deepEqual([raw.w, raw.h], [64, 128]);
  assert.deepEqual([i.u0, i.v0, i.uw, i.vh, i.lw, i.lh], [16, 4, 32, 8, 32, 8]);
  const scene = new Scene(openLa3(sample()), { lookup: () => ({ ...i, iw: raw.w, ih: raw.h }) });
  const p = scene.primitives();
  assert.deepEqual(p.find(p => p.id === 2).uv, [[16, 4], [32, 4], [32, 12], [16, 12]]);
  assert.deepEqual(p.find(p => p.id === 3).uv, [[17, 4], [23, 4], [23, 16], [17, 16]]);
});

test('PW QAR: entries sit at 0x1000 boundaries, the table at the end', () => {
  const a = Uint8Array.from({ length: 0x1234 }, (_, i) => i & 0xFF), b = Uint8Array.of(1, 2, 3);
  const bytes = le(w => {
    w.bytes(a).zeros(0x2000 - a.length).bytes(b).zeros(0x1000 - b.length);
    const toc = w.length;
    w.u32(2).u32(0x14000001).u32(a.length).u32(0x14000002).u32(b.length);
    w.bytes(latin1.encode('a.txp\0b.txp\0')).align(4).u32(toc);
  });
  const q = readPwQar(bytes);
  assert.deepEqual(q.map(e => [e.name, e.data.length, e.data[0]]), [['a.txp', 0x1234, 0], ['b.txp', 3, 1]]);
  assert.equal(readPwQar(new Uint8Array(64)), null);
});

test('LA3 runtime blend modes include disabled blending and keep all angle bits and signed scale', () => {
  for (const [mode, expected] of [[0, 'normal'], [1, 'add'], [2, 'sub'], [3, 'none'], [-1, 'none']]) {
    const record = object(0, 0xFFFF, 0x123456, SPRT, { 16: 2, 17: -256, 18: mode });
    const bytes = la3([[0x20, le(w => w.u16(1).u16(0).u16(0).u16(0))], [0x21, record]]);
    const state = new Scene(openLa3(bytes), null).state.get(1);
    assert.equal(state.blend, expected);
    assert.equal(state.rotate, -2 / 16);   // raw LA3 65536/turn -> negative LA2 4096/turn, no lost low bits
    assert.equal(state.scale, -256);
  }
});

test('LA3 control-vertex lists use byte indices, and start-action keys preserve both hashes', () => {
  const key = le(w => w.u16(5).u16(12).u32(0x01123456).u32(0x654321));
  const bytes = la3([
    [0xB0, le(w => w.u16(2).u16(0).u16(2).u16(0).u16(1).u16(2))],
    [0xB1, Uint8Array.of(0, 3, 7)],
    [0x50, le(w => w.u16(1).u16(0).u32(0))], [0x51, key],
    [0x40, le(w => w.u16(1).u16(0).u32(0x01ABCDEF).u32(0x654321).u32(0).u16(1).u16(0))],
    [0x41, le(w => w.u16(0))],
  ]);
  const la = openLa3(bytes), L = la.la3;
  assert.deepEqual(L.controlVertices.map(v => [...v]), [[0, 3], [7]]);
  assert.equal(L.keys[0].action, 0x01123456);
  assert.equal(L.keys[0].object, 0x654321);
  assert.deepEqual(la.la3Tracks, [L.tracks]);
  assert.equal(la.la3Signals.size, 0);  // a type-5 action start is distinct from a game's callback
});
