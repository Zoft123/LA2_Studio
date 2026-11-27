// LA3: the 2D layout / animation format of Metal Gear Solid: Peace Walker (PSP engine; here the PS3 HD port, whose
// files stay little-endian and are byte-swapped by the game on load: EBOOT sub_C00B5C). Libla's successor: the same
// object types and ideas as LA2, packed tighter. Read here and converted into an LA2 (v0x10008, little-endian) in
// memory, so the rest of LA2 Studio (scene, playback, inspector) works on it unchanged; LA3 files are view-only.
//
// header   "FEL" + version byte (7; 5 and 4 in a few older files, not read yet), u32 0, u16, u16 0x0404,
//          u32 300 (ticks per second, as libla's clock)
// chunks   {u8 type, u24 size} + size bytes, up to type 0. Each section starts with {u16 count, u16 x}.
//   0x20   objects: count x u16 offset into 0x21
//   0x21   object {u16 id, u16 parent (0xFFFF = none), u32 name hash, u32 type (low nibble: LA2 object type),
//          u32 mask, u32 ?, then one 16-bit value per set mask bit, lowest bit first} = the initial state
//   0x40   actions: 16-byte records {u32 hash, u32 object name hash, u32 length (ticks), u16 key count, u16 first}
//          into 0x41. Each record animates one object; records whose hashes share the low 24 bits (the high byte
//          numbers them 1, 2, ...) form one action.
//   0x41   u16 key numbers (into 0x50)
//   0x50   count x u32 offset into 0x51
//   0x51   key {u16 type, u16 size, ...}: 0 end; 1 set {u32 mask, values}; 2 morph {u32 ticks, u32 mask, values};
//          3 wait {u32 ticks}; 4 signals for the game {u32 pairs (command, argument)}; 5 {u32, u32} (one file)
//   0x80   textures: {u16 count, u16 hash count}, count x {u8 texture-hash index, u8 TXP-hash index} (u16s when
//          there are 256+ hashes); 0x81 the hashes (u32, sorted)
//   0x90   point lists: count x {u8 points, u8 ?, u16 first} into 0x91 {i16 x, i16 y} (positions in 1/16 px,
//          sizes, UVs in 1/16 texel of the texture)
//   0xA0   colour lists: count x {u16 colours, u16 first} into 0xA1 {u8 r, g, b, a} (alpha 0x80 = opaque)
//   0xC0   texts: count x {u16 length, u16 offset} into 0xC1 (bytes)
//   0xD0   fonts {u32 hash, u16 glyphs, u16 first} into 0xD1 glyphs {u32 code, u16 size list, u16 UV list}
//   0xB0 / 0xB1  unknown (400 files)
// Mask bits (one value each): 2 visible, 4 position list, 5 colour list, 6 size list (Box / Sprt / String),
// 7 UV list, 9 ? (0..6), 10 String spacing list, 11 text, 16 rotation (65536 = full turn), 17 scale (256 = 1.0),
// 18 blend? (0..2), 19 texture, 20 / 28 RSprt flags, 22 font, 23 alignment; 12, 13, 24..27 Typing only.
import { Reader, Writer } from '../core/bin.js';
import { LA2 } from './la2.js';
import { txpTexKey } from './txp.js';

export const LA3_MAGIC = 'FEL';
export const isLa3 = b => b.length >= 16 && b[0] === 0x46 && b[1] === 0x45 && b[2] === 0x4C;

export const MASK_BITS = { 2: 'visible', 4: 'xy', 5: 'rgba', 6: 'wh', 7: 'uv', 9: 'bit9', 10: 'space', 11: 'text',
  12: 'typing12', 13: 'typing13', 16: 'rotate', 17: 'scale', 18: 'bit18', 19: 'texture', 20: 'bit20', 22: 'font',
  23: 'align', 24: 'typing24', 25: 'typing25', 26: 'typing26', 27: 'typing27', 28: 'bit28' };
export const LA3_KEYS = { 0: 'end', 1: 'set', 2: 'morph', 3: 'wait', 4: 'signals', 5: 'k5' };
const NO_PARENT = 0xFFFF;
const ROTATE_TO_LA2 = 1 / 16;                       // LA3 65536 per turn -> LA2 4096
const BLEND = [0x1010, 0x1020, 0x2001];             // bit 18 0 / 1 / 2 -> LA2 normal / add / sub (guess)

function chunks(b) {
  const out = new Map();
  for (let o = 16; o + 4 <= b.length;) {
    const type = b[o], size = b[o + 1] | (b[o + 2] << 8) | (b[o + 3] << 16);
    if (!out.has(type)) out.set(type, { offset: o + 4, size });
    o += 4 + size;
    if (type === 0) break;
  }
  return out;
}

/** Parse an LA3 file (version 7). */
export function parseLa3(bytes) {
  if (!isLa3(bytes)) throw new Error('not an LA3 file');
  const version = bytes[3];
  if (version !== 7) throw new Error(`LA3 version ${version} is not supported yet (only version 7)`);
  const r = new Reader(bytes, true), S = chunks(bytes);
  const sec = t => S.get(t)?.offset;
  const count = t => S.has(t) && S.get(t).size >= 4 ? r.u16(sec(t)) : 0;

  const lists = [];
  for (let i = 0; i < count(0x90); i++) {
    const o = sec(0x90) + 4 + 4 * i, n = r.u8(o), first = r.u16(o + 2), pts = [];
    for (let k = 0; k < n; k++) pts.push([r.i16(sec(0x91) + 4 * (first + k)), r.i16(sec(0x91) + 4 * (first + k) + 2)]);
    lists.push(pts);
  }
  const colors = [];
  for (let i = 0; i < count(0xA0); i++) {
    const o = sec(0xA0) + 4 + 4 * i, n = r.u16(o), first = r.u16(o + 2), c = [];
    for (let k = 0; k < n; k++) { const p = sec(0xA1) + 4 * (first + k); c.push([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]); }
    colors.push(c);
  }
  // textures: (texture hash, TXP hash) pairs
  const textures = [];
  if (S.has(0x80)) {
    const o = sec(0x80), n = r.u16(o), nh = r.u16(o + 2), wide = nh >= 0x100;
    const hashes = Array.from({ length: nh }, (_, k) => r.u32(sec(0x81) + 4 * k));
    for (let i = 0; i < n; i++) {
      const [ti, pi] = wide ? [r.u16(o + 4 + 4 * i), r.u16(o + 6 + 4 * i)] : [r.u8(o + 4 + 2 * i), r.u8(o + 5 + 2 * i)];
      textures.push({ tex: hashes[ti] ?? 0, txp: hashes[pi] ?? 0 });
    }
  }
  const texts = [];
  for (let i = 0; i < count(0xC0); i++) {
    const o = sec(0xC0) + 4 + 4 * i, n = r.u16(o), at = sec(0xC1) + r.u16(o + 2);
    texts.push(bytes.slice(at, at + n));
  }
  // fonts: glyph cells (size list: w, h in 1/16 px; UV list: two corners in 1/16 texel of the String's texture),
  // keyed by the character's bytes (the u32 code's bytes, low first, without trailing zeros)
  const fonts = [];
  for (let i = 0; i < count(0xD0); i++) {
    const o = sec(0xD0) + 4 + 8 * i, n = r.u16(o + 4), first = r.u16(o + 6), glyphs = new Map();
    for (let k = first; k < first + n && k < count(0xD1); k++) {
      const g = sec(0xD1) + 4 + 8 * k, code = r.u32(g);
      let s = '';
      for (let c = code; c; c >>>= 8) s += String.fromCharCode(c & 0xFF);
      const [w, h] = lists[r.u16(g + 4)]?.[0] || [0, 0], uv = lists[r.u16(g + 6)] || [[0, 0], [0, 0]];
      const [[u0, v0], [u1, v1]] = uv.length >= 2 ? uv : [[0, 0], [0, 0]];
      if (!glyphs.has(s || '\0')) glyphs.set(s || '\0', [w, h, u0, u1, v0, v1]);
    }
    fonts.push({ hash: r.u32(o), glyphs });
  }
  const readMask = (mask, at) => {
    const values = new Map();
    for (let b = 0; b < 32; b++) if (mask >>> b & 1) { values.set(b, r.i16(at)); at += 2; }
    return values;
  };
  const objects = [];
  for (let i = 0; i < count(0x20); i++) {
    const p = sec(0x21) + r.u16(sec(0x20) + 4 + 2 * i);
    const type = r.u32(p + 8), mask = r.u32(p + 12);
    objects.push({ index: i, id: r.u16(p), parent: r.u16(p + 2), hash: r.u32(p + 4), type: type & 0xF, typeFlags: type >>> 4,
      mask, x16: r.u32(p + 16), values: readMask(mask, p + 20), offset: p });
  }
  const keys = [];
  for (let i = 0; i < count(0x50); i++) {
    const p = sec(0x51) + r.u32(sec(0x50) + 4 + 4 * i), type = r.u16(p), size = r.u16(p + 2);
    const k = { index: i, type, size, offset: p };
    if (type === 1) { k.mask = r.u32(p + 4); k.values = readMask(k.mask, p + 8); }
    else if (type === 2) { k.ticks = r.u32(p + 4); k.mask = r.u32(p + 8); k.values = readMask(k.mask, p + 12); }
    else if (type === 3) k.ticks = r.u32(p + 4);
    else if (type === 4) { k.words = []; for (let q = p + 4; q + 4 <= p + size; q += 4) k.words.push(r.u32(q)); }
    keys.push(k);
  }
  const tracks = [];
  for (let i = 0; i < count(0x40); i++) {
    const o = sec(0x40) + 4 + 16 * i, n = r.u16(o + 12), first = r.u16(o + 14);
    const keyList = Array.from({ length: n }, (_, k) => r.u16(sec(0x41) + 2 * (first + k)));
    tracks.push({ hash: r.u32(o), object: r.u32(o + 4), length: r.u32(o + 8), keys: keyList });
  }
  return { version, ticksPerSecond: r.u32(12), lists, colors, textures, texts, fonts, objects, keys, tracks, sections: S };
}

// ---- conversion to LA2 ------------------------------------------------------------------------------------------
function packetWriter() {
  const w = new Writer(true, 256);
  let n = 0;
  const packet = (type, body = []) => {             // body: [['I' | 'H' | 'h' | 'B', value] | Uint8Array]
    const at = w.length;
    w.u16(type).u16(0);
    for (const item of body) {
      if (item instanceof Uint8Array) w.bytes(item);
      else { const [f, v] = item; if (f === 'I') w.u32(v); else if (f === 'H') w.u16(v & 0xFFFF); else if (f === 'h') w.i16(v); else w.u8(v); }
    }
    w.align(4);
    w.setU16(at + 2, w.length - at);
    n++;
  };
  return { packet, count: () => n, bytes: () => w.result() };
}

/** LA2 packets of an LA3 mask + values (an object's initial state or a key's target). */
function packets(L, values) {
  const pw = packetWriter();
  const list = i => L.lists[i] || [];
  for (const [bit, v] of values) {
    if (bit === 2) pw.packet(v ? 1 : 2);
    else if (bit === 4) {
      const pts = list(v);
      pw.packet(3, [['I', 1], ['H', pts.length], ['H', 0], ...pts.flatMap(([x, y]) => [['h', x], ['h', y]])]);
    } else if (bit === 5) pw.packet(6, [['I', 1], ['H', 0], ['H', (v & 0xFFF) | 0xF000]]);
    else if (bit === 6) { const [wv, hv] = list(v)[0] || [0, 0]; pw.packet(5, [['I', 1], ['h', wv], ['h', hv]]); }
    else if (bit === 7) pw.packet(8, [['I', v & 0xFFFF]]);
    else if (bit === 10) pw.packet(14, [['h', (list(v)[0] || [0])[0]]]);
    else if (bit === 11) { const t = L.texts[v & 0xFFFF] || new Uint8Array(0); pw.packet(13, [['I', t.length], t]); }
    else if (bit === 16) pw.packet(11, [['h', Math.round(v * ROTATE_TO_LA2)], ['h', 0]]);
    else if (bit === 17) pw.packet(10, [['I', v & 0xFFFF]]);
    else if (bit === 18) pw.packet(9, [['I', BLEND[v] ?? BLEND[0]]]);
    else if (bit === 19) pw.packet(7, [['I', (v & 0xFFFF) + 1]]);
    else if (bit === 22) pw.packet(18, [['h', v + 1]]);
    else if (bit === 23) pw.packet(19, [['h', v]]);
  }
  return pw;
}

/** An LA2 (v0x10008, little-endian) holding the LA3's objects, states, actions, textures, colours and UV lists. */
export function la3ToLa2(L) {
  const w = new Writer(true, 1 << 16);
  const N_SECTIONS = 12;
  w.u32(0x10008);
  const header = w.length;
  w.zeros(4 * N_SECTIONS);
  const section = (i, at = w.length) => w.setU32(header + 4 * i, at);
  const la2Id = id => id + 1;                         // LA2 ids start at 1: parent 0 is the root
  const byHash = new Map();
  for (const o of L.objects) if (!byHash.has(o.hash)) byHash.set(o.hash, o);

  // objects (tagLA2_OBJ_DEF_HEADER counts, then the objects, no units)
  section(0);
  w.u16(L.objects.length); w.zeros(42);
  for (const o of L.objects) {
    w.u32(o.hash).u32(o.type).u16(la2Id(o.id)).u16(o.parent === NO_PARENT ? 0 : la2Id(o.parent)).u16(0).u16(0).u16(0).u16(0);
  }
  // status: the objects' initial states, then one block per (key, object type) that keys point at
  section(1);
  const blocks = [], blockAt = new Map();
  const block = values => { const pw = packets(L, values); blocks.push(pw); return blocks.length - 1; };
  for (const o of L.objects) block(o.values);
  const keyBlock = new Map();
  for (const t of L.tracks) for (const ki of t.keys) {
    const k = L.keys[ki];
    if (k && (k.type === 1 || k.type === 2) && !keyBlock.has(ki)) keyBlock.set(ki, block(k.values));
  }
  w.u32(blocks.length);
  blocks.forEach((pw, i) => { const b = pw.bytes(); blockAt.set(i, w.length); w.u16(pw.count()).u16(4 + b.length).bytes(b); });

  // actions: the LA3 action records grouped by the low 24 bits of their hash
  section(2);
  const groups = new Map();
  for (const t of L.tracks) {
    const h = t.hash & 0xFFFFFF;
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(t);
  }
  w.u32(groups.size);
  const actionAt = [];
  for (const [h, tracks] of groups) {
    const start = w.length;
    actionAt.push([h, start]);
    w.u16(tracks.length).u16(0).u16(0).u16(0);
    for (const t of tracks) {
      const o = byHash.get(t.object), tStart = w.length;
      w.u16(o ? la2Id(o.id) : 0xFFFF).u16(t.keys.length).u32(0);
      for (const ki of t.keys) {
        const k = L.keys[ki];
        if (!k || k.type === 0) w.u16(0).u16(4);
        else if (k.type === 1) w.u16(7).u16(8).u32(blockAt.get(keyBlock.get(ki)));
        else if (k.type === 2) w.u16(8).u16(12).u32(k.ticks).u32(blockAt.get(keyBlock.get(ki)));
        else if (k.type === 3) w.u16(4).u16(8).u32(k.ticks);
        else if (k.type === 4) {
          const words = k.words.length % 2 ? [...k.words, 0] : k.words;
          w.u16(1).u16(8 + 4 * words.length).u32(words.length / 2);
          for (const x of words) w.u32(x);
        } else w.u16(4).u16(8).u32(0);
      }
      w.setU32(tStart + 4, w.length - tStart);
    }
    w.setU16(start + 4, Math.min(0xFFFF, w.length - start));
  }
  section(3);
  w.u32(actionAt.length);
  for (const [h, at] of actionAt) w.u32(h).u32(at);
  // textures (texture hash, TXP hash); lookup keys are set on the LA2 afterwards
  section(6);
  w.u32(L.textures.length);
  for (const t of L.textures) w.u32(t.tex).u32(t.txp);
  // colour and UV lists keep their LA3 numbers
  section(7);
  w.u32(L.colors.length);
  for (const c of L.colors) { w.u16(c.length).u16(4 + 4 * c.length); for (const x of c) w.bytes(Uint8Array.from(x)); }
  section(8);
  w.u32(L.lists.length);
  for (const l of L.lists) { w.u16(l.length).u16(4 + 4 * l.length); for (const [a, b] of l) w.u16(a & 0xFFFF).u16(b & 0xFFFF); }
  // one layer holding everything
  section(11);
  w.u32(1).u32(0).u16(0).u16(L.objects.length);
  return w.result();
}

/** Open an LA3 as an LA2 model (view-only). Extra fields: la.la3 (the parsed LA3), la.texKeys (TXP texture keys),
 *  la.uvUnit (UV lists and glyph UVs are in 1/16 texel of each texture); la.fonts holds the LA3 glyphs, whose UVs
 *  are in those units too (LA2's are 0..65535 of the texture). */
export function openLa3(bytes) {
  const L = parseLa3(bytes);
  const la = new LA2(la3ToLa2(L));
  la.la3 = L;
  la.source = bytes;
  la.texKeys = L.textures.map(t => txpTexKey(t.tex, t.txp));
  la.uvUnit = 16;
  la.fonts = L.fonts;
  return la;
}
