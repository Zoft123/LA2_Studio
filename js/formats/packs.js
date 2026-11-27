// Packed game data, read in place: the containers each game ships its stages and slots in, so their layouts and
// textures can be opened without extracting anything first. Every reader works on a byte source
// {size, read(offset, length) -> Promise<Uint8Array>} (only the parts it needs are read: a 700 MB SLOT.DAT is never
// loaded whole) and returns a pack {kind, label, entries: [{path, size, hash?}], read(path) -> Promise<Uint8Array>}
// whose entry paths are relative to the container ("w01s01a/cache.dar", "slot_012/1a2b3c.la2").
//
//   Portable Ops (PSP)        stage/<name>/_zar        u32 size + zlib stream of a DAR (the stage's files)
//                             slot.dat                 plain slots (below), sector 0x800
//   MGS3 / MGO1 (PS2)         STAGE*.DAT               encrypted directory, per-stage TOC, encrypted zlib sections
//                             SLOT*.DAT                plain slots
//   MGS3 HD (PS3)             *.psarc                  PSARC: TOC + zlib blocks, file names in its manifest
//   Peace Walker HD (PS3)     STAGEDAT.PDT             encrypted index + lookup tree, one encrypted zlib entry per file
//                             SLOT.DAT + SLOT.KEY      encrypted zlib slots, index in SLOT.KEY
//
// Formats as the games read them: MGS3_N.ELF (MGO1) for STAGE / SLOT.DAT, the PW EBOOT and Chrysalis
// (github.com/Jayveer/Chrysalis) for STAGEDAT.PDT and SLOT.DAT. Files that only have a name hash on disc are named
// <hash>.<ext> (24-bit StrCode hash, six hex digits), the way the extracted folders the app already reads name them.
import { readDar, writeDar } from './archives.js';
import { inflateSync, zlibSync, Inflate } from '../vendor/fflate.js';
import { strcode, latin1 } from '../core/bin.js';

const KEY_MUL = 0x02E90EDD;            // every cipher here: key = key * KEY_MUL + step, per little-endian u32
const align = (v, a) => Math.ceil(v / a) * a;
const hex6 = h => h.toString(16).padStart(6, '0');
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const u16 = (b, o) => b[o] | b[o + 1] << 8;
const be32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;

/** XOR the little-endian words of `bytes` (in place) with the key stream; returns the next key. */
function crypt(bytes, key, step) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 0; o + 4 <= bytes.length; o += 4) {
    dv.setUint32(o, (dv.getUint32(o, true) ^ key) >>> 0, true);
    key = (Math.imul(key, KEY_MUL) + step) >>> 0;
  }
  return key;
}
const copy = b => new Uint8Array(b);            // the sources may hand out shared buffers: decrypt a copy

/** Inflate a zlib stream (header skipped, checksum not required: some streams carry padding after it). */
function inflateZlib(bytes, size) {
  return inflateSync(bytes.subarray(2), size ? { out: new Uint8Array(size) } : undefined);
}
/** The first `want` bytes of a zlib stream that arrives in pieces: next(n) returns more compressed input, or null. */
async function inflateHead(first, want, next) {
  const parts = []; let have = 0, done = false;
  const inf = new Inflate((chunk, final) => { parts.push(chunk); have += chunk.length; if (final) done = true; });
  let input = first.subarray(2);
  for (;;) {
    inf.push(input, false);
    if (have >= want || done) break;
    input = await next();
    if (!input) break;
  }
  const out = new Uint8Array(have); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- extension tables ----------------------------------------------------------------------------------------
/** MGS3 / MGO1 (PS2) file types (MGS3_N.ELF; each checked against extracted files). */
const PS2_EXT = { 0x01: 'bin', 0x02: 'gcx', 0x03: 'tri', 0x06: 'lt2', 0x08: 'mtar', 0x09: 'mtsq', 0x0c: 'geom',
  0x0d: 'mdl', 0x0f: 'nav', 0x10: 'cvd', 0x11: 'eft', 0x5e: 'ico', 0x5f: 'la2', 0x68: 'var', 0x69: 'img', 0x6c: 'rcm',
  0x6e: 'raw' };
/** Peace Walker (and Portable Ops) file types: the game's table (PW EBOOT 0x11AD228). Type 0x13 is shared by
 *  mdp / mdc / mdl / mdb. */
const PW_EXT_LIST = [['mdpe', 26], ['qar', 241], ['vrdv', 33], ['vrd', 32], ['mgm', 48], ['mds', 5], ['row', 110],
  ['spk', 29], ['cap', 53], ['rat', 107], ['mtfa', 10], ['eqp', 100], ['psq', 255], ['dcd', 27], ['mtst', 24],
  ['gcx', 2], ['cvd', 16], ['bgp', 56], ['ohd', 30], ['tri', 3], ['rpd', 22], ['mdp', 19], ['vlm', 101], ['vcpg', 36],
  ['kms', 21], ['la2', 95], ['ptcp', 51], ['vcp', 35], ['fcx', 23], ['ola', 109], ['rcm', 108], ['lt2', 6],
  ['olang', 93], ['mtsq', 9], ['pcmp', 54], ['vram', 97], ['mdh', 4], ['mmd', 31], ['bin', 1], ['mdpb', 25],
  ['img', 105], ['mdc', 19], ['vib', 106], ['zon', 18], ['cddl', 52], ['txp', 20], ['vrdt', 34], ['nav', 15],
  ['cmf', 99], ['png', 104], ['la3', 94], ['lst', 102], ['dar', 240], ['ypk', 28], ['rlc', 50], ['mtra', 111],
  ['geom', 12], ['cv2', 7], ['prx', 49], ['mtar', 8], ['eft', 17], ['slot', 96], ['mdl', 19], ['mtcm', 11],
  ['sep', 55], ['mdb', 19], ['cnf', 242]];
const PW_EXT = {}, PW_TYPE = {};
for (const [name, code] of PW_EXT_LIST) { if (!(code in PW_EXT)) PW_EXT[code] = name; PW_TYPE[name] = code; }
const extName = (table, type) => table[type] || 'x' + type.toString(16).padStart(2, '0');

/** "<hash>.<ext>" entry of a file stored by (type << 24 | name hash). */
const hashedEntry = (dir, id, table, size, extra) =>
  ({ path: dir + '/' + hex6(id & 0xFFFFFF) + '.' + extName(table, id >>> 24), size, hash: id & 0xFFFFFF, ...extra });

/** Byte ranges of the files of one section: a file runs from its offset to the next larger offset. */
function sectionFiles(files, size) {
  const offs = [...new Set([...files.map(f => f.off), size])].sort((a, b) => a - b);
  const next = off => {                                   // smallest offset above `off` (binary search)
    let lo = 0, hi = offs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (offs[m] > off) hi = m; else lo = m + 1; }
    return lo < offs.length ? offs[lo] : size;
  };
  return files.map(f => ({ ...f, end: next(f.off) }));
}

// ---- Portable Ops stage: _zar -----------------------------------------------------------------------------------
/** stage/<name>/_zar: u32 raw size, then a zlib stream of the stage's DAR (data.cnf, cache.dar, cache.qar, ...). */
export async function openZar(src) {
  if (src.size < 8 || src.size > (512 << 20)) return null;
  const all = await src.read(0, src.size);
  const raw = u32(all, 0);
  if (all[4] !== 0x78 || raw < 8 || raw > (1 << 30)) return null;
  const inflate = () => { const d = inflateZlib(all.subarray(4), raw); if (d.length !== raw) throw new Error('_zar: short stream'); return d; };
  const dar = readDar(inflate());
  const entries = dar.entries.map(e => ({ path: e.name, size: e.size, offset: e.offset }));
  const byName = new Map(entries.map(e => [e.path, e]));
  let cache = null;
  const data = () => cache || (cache = inflate());
  return {
    kind: 'zar', label: 'Portable Ops stage archive', entries,
    async read(path) { const e = byName.get(path); if (!e) throw new Error('no such file: ' + path); const d = data(); return d.slice(e.offset, e.offset + e.size); },
    forget() { cache = null; },
    /** The _zar with some of its files replaced ({name: bytes}): DAR rebuilt, compressed again. */
    rebuild(replace) {
      const d = data(), info = readDar(d);
      const files = info.entries.map(e => ({ name: e.name, data: replace[e.name] || d.subarray(e.offset, e.offset + e.size) }));
      const out = writeDar(files, info.le, d.subarray(info.end));
      const z = zlibSync(out, { level: 9 });
      const res = new Uint8Array(4 + z.length);
      new DataView(res.buffer).setUint32(0, out.length, true);
      res.set(z, 4);
      return res;
    },
  };
}

// ---- MGS3 / MGO1: STAGE*.DAT --------------------------------------------------------------------------------------
/** STAGE.DAT / STAGE_2.DAT / STAGE_N.DAT (MGS3_N.ELF sub_1012F0 / sub_1013B8 / sub_101810 / sub_100D80):
 *  directory {u32 w0, then (key w0, step w0 ^ 0xF0F0) 12 bytes with s16 count at +4, count x {name[16], u32 sector}};
 *  per stage (key from StrCode(name)) a TOC {u32 n, n x {u32 a, u32 b}}: 7F0000xx = section of size b, 7E + 24-bit
 *  compressed size / b = its offset after the TOC, TT + 24-bit hash / b = a file at offset b in the section,
 *  7F000000 = end. Sections are encrypted zlib streams (key from their first u16); 7F000010 is the stage's raw
 *  sound bank, skipped here. */
export async function openPs2Stage(src) {
  if (src.size < 0x1000) return null;
  const head = copy(await src.read(0, 16));
  const w0 = u32(head, 0), step = (w0 ^ 0xF0F0) >>> 0;
  const hdr = head.subarray(4);
  let key = crypt(hdr, w0, step);
  const count = u16(hdr, 4);
  if (count < 1 || count > 4096 || (count & 0x8000)) return null;
  const dir = copy(await src.read(16, 20 * count));
  crypt(dir, key, step);
  const stages = [];
  for (let i = 0; i < count; i++) {
    const nameBytes = dir.subarray(20 * i, 20 * i + 16), z = nameBytes.indexOf(0);
    const name = latin1.decode(nameBytes.subarray(0, z < 0 ? 16 : z));
    const sector = u32(dir, 20 * i + 16);
    if (!/^[\w.-]{1,16}$/.test(name) || sector * 0x800 >= src.size) return null;
    stages.push({ name, sector });
  }
  const entries = [], sections = new Map();
  for (const st of stages) {
    const t1 = strcode(st.name) || 1;
    const k0 = (Math.imul(t1, 129) + w0 + 0xA78925D9) >>> 0, s0 = (Math.imul(t1, 129) + 0x7A88FB59) >>> 0;
    const at = st.sector * 0x800;
    const first = copy(await src.read(at, 4)); crypt(first, k0, s0);
    const n = u32(first, 0);
    if (n > 100000) continue;
    const tocLen = align(4 + 8 * n, 0x800);
    const toc = copy(await src.read(at, tocLen)); crypt(toc, k0, s0);
    const data0 = at + tocLen;
    const secs = []; let cur = null;
    for (let j = 0; j < n; j++) {
      const a = u32(toc, 4 + 8 * j), b = u32(toc, 8 + 8 * j), top = a >>> 24;
      if (top === 0x7F && a !== 0x7F000000) cur = { tag: a, size: b, comp: null, files: [] };
      else if (a === 0x7F000000) { if (cur) secs.push(cur); cur = null; }
      else if (top === 0x7E) { if (cur) cur.comp = { size: a & 0xFFFFFF, off: b }; }
      else if ((a || b) && cur) cur.files.push({ id: a, off: b });
    }
    // where each section's data is (sub_101DF8): compressed ones at their offset, the others in sequence
    let pos = 0;
    for (const sc of secs) {
      if (sc.comp) { sc.at = data0 + sc.comp.off; pos = sc.comp.off + align(sc.comp.size, 0x800); }
      else { sc.at = data0 + pos; pos += align(sc.size, 0x800); }
      if (sc.tag === 0x7F000010) continue;            // sound bank (IOP stream)
      const id = st.name + '|' + sc.tag.toString(16);
      sections.set(id, sc);
      for (const f of sectionFiles(sc.files, sc.size)) entries.push(hashedEntry(st.name, f.id, PS2_EXT, f.end - f.off, { section: id, off: f.off, end: f.end }));
    }
  }
  if (!entries.length) return null;
  const byPath = new Map(entries.map(e => [e.path, e]));
  const loaded = new Map();
  async function section(id) {
    if (loaded.has(id)) { const d = loaded.get(id); loaded.delete(id); loaded.set(id, d); return d; }
    const sc = sections.get(id);
    let d;
    if (sc.comp) {
      const raw = copy(await src.read(sc.at, align(sc.comp.size, 4)));
      const k = (u16(raw, 0) ^ 0x9385) & 0xFFFF;
      crypt(raw, (((k ^ 0x6576) << 16) | k) >>> 0, Math.imul(k, 0x116) >>> 0);
      const w = (u16(raw, 0) + 0x8F3) & 0xFFFF;
      raw[0] = w & 0xFF; raw[1] = w >> 8;
      d = inflateZlib(raw, sc.size);
    } else d = await src.read(sc.at, sc.size);
    loaded.set(id, d);
    while (loaded.size > 6) loaded.delete(loaded.keys().next().value);
    return d;
  }
  return {
    kind: 'ps2-stage', label: 'MGS3 / MGO1 stage data', entries,
    async read(path) { const e = byPath.get(path); if (!e) throw new Error('no such file: ' + path); return (await section(e.section)).slice(e.off, e.end); },
    forget() { loaded.clear(); },
  };
}

// ---- plain slots: MGS3 / MGO1 SLOT*.DAT, Portable Ops slot.dat --------------------------------------------------
/** {u32 stamp, u16 1, u16 sector multiple, u16 slot count, ...} (rest of the first sector unused), then each slot in
 *  sequence: a stage-style TOC padded to the sector, then its uncompressed sections. Slots have no names on disc:
 *  slot_NNN is the Nth. Portable Ops uses the same layout (with its own file types: TXP textures). */
export async function openPlainSlot(src) {
  if (src.size < 0x1000) return null;
  const head = await src.read(0, 16);
  const version = u16(head, 4), mult = u16(head, 6), count = u16(head, 8);
  if (version !== 1 || mult < 1 || mult > 16 || count < 1) return null;
  const sector = 0x800 * mult;
  const slots = [];
  let sec = 1;
  for (let i = 0; i < count; i++) {
    const at = sec * sector;
    if (at + 4 > src.size) return null;
    let toc = await src.read(at, Math.min(sector, src.size - at));
    const n = u32(toc, 0);
    if (n < 1 || n > 20000) return null;
    const tocLen = align(4 + 8 * n, sector);
    if (tocLen > toc.length) toc = await src.read(at, tocLen);
    const data0 = at + tocLen, secs = [];
    let pos = 0, cur = null;
    for (let j = 0; j < n; j++) {
      const a = u32(toc, 4 + 8 * j), b = u32(toc, 8 + 8 * j), top = a >>> 24;
      if (top === 0x7F && a !== 0x7F000000) cur = { tag: a, size: b, at: data0 + pos, files: [] };
      else if (a === 0x7F000000) { if (cur) { secs.push(cur); pos += align(cur.size, sector); } cur = null; }
      else if (top === 0x7E) return null;                    // compressed: not a plain slot file
      else if ((a || b) && cur) cur.files.push({ id: a, off: b });
    }
    slots.push(secs);
    sec += (tocLen + pos) / sector;
  }
  if (sec * sector > align(src.size, sector)) return null;
  const psp = slots.some(s => s.some(sc => sc.files.some(f => f.id >>> 24 === 0x14)));     // TXP textures: Portable Ops
  const table = psp ? PW_EXT : PS2_EXT, digits = String(count - 1).length < 3 ? 3 : String(count - 1).length;
  const entries = [];
  slots.forEach((secs, i) => {
    const dir = 'slot_' + String(i).padStart(digits, '0');
    for (const sc of secs) for (const f of sectionFiles(sc.files, sc.size))
      entries.push(hashedEntry(dir, f.id, table, f.end - f.off, { at: sc.at + f.off }));
  });
  if (!entries.length) return null;
  const byPath = new Map(entries.map(e => [e.path, e]));
  return {
    kind: psp ? 'psp-slot' : 'ps2-slot', label: psp ? 'Portable Ops slot data' : 'MGS3 / MGO1 slot data', entries,
    async read(path) { const e = byPath.get(path); if (!e) throw new Error('no such file: ' + path); return copy(await src.read(e.at, e.size)); },
  };
}

// ---- Peace Walker HD: STAGEDAT.PDT ----------------------------------------------------------------------------------
/** Stage names are not stored: a file is found by a key made of StrCode(stage) and (type << 24 | StrCode(name))
 *  (see lookupKey). Every stage has a data.cnf listing its files, so the stages are the entries whose key is that
 *  of some stage's data.cnf; the stage's name comes from its config (its <stage>.rlc / .nav / .geom ...). */
const cnfId = ((PW_TYPE.cnf << 24) ^ strcode('data')) >>> 0;
/** Lookup key of file `name` of the stage with name hash `s` (Chrysalis lookupHash; the EBOOT does the same). */
function lookupKey(s, fileId) { return (~(((s >>> 4) ^ (s << 4)) ^ 0x10EA) ^ fileId) >>> 0; }
/** The stage hash s of a key, if it is the key of a data.cnf: inverts g = (s >> 4) ^ (s << 4) for 24-bit s. */
function stageOfCnfKey(key) {
  const g = (~(key ^ cnfId) ^ 0x10EA) >>> 0;
  const G = (a, b) => (g >>> a) & ((1 << (b - a)) - 1);
  const s20 = G(24, 28), s16 = G(20, 24), s12 = G(16, 20) ^ s20, s8 = G(12, 16) ^ s16, s4 = G(0, 4), s0 = G(4, 8) ^ s8;
  const s = s0 | s4 << 4 | s8 << 8 | s12 << 12 | s16 << 16 | s20 << 20;
  return (((s >>> 4) ^ (s << 4)) >>> 0) === g ? s : null;
}
const fileId = name => {
  const dot = name.lastIndexOf('.');
  const type = PW_TYPE[name.slice(dot + 1).toLowerCase()];
  return type === undefined ? null : ((type << 24) ^ (strcode(name.slice(0, dot)) || 1)) >>> 0;
};
/** File names a data.cnf lists: lines without a leading '.' (@ = QAR, ? = AFP), and the names after ".vram". */
export function cnfFiles(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '.') { const t = line.slice(1).split(/\s+/); if (t[0] === 'vram') out.push(...t.slice(1)); continue; }
    out.push(line.replace(/^[@?]/, ''));
  }
  return out;
}

export async function openPwStagedat(src) {
  if (src.size < 0x1000) return null;
  const head = copy(await src.read(0, 32));
  const [sA, sB, sC] = [u32(head, 0), u32(head, 4), u32(head, 8)];
  const v = (sA ^ sB) >>> 0, keyA = (v | ((v ^ 0x6576) << 16)) >>> 0, keyB = Math.imul(v, sC) >>> 0;
  let k = crypt(head.subarray(12), keyA, keyB);
  const count = u16(head, 24);
  if (!count || 32 + 28 * count > src.size) return null;
  const tables = copy(await src.read(32, 28 * count));
  k = crypt(tables.subarray(0, 12 * count), k, keyB);
  crypt(tables.subarray(12 * count), k, keyB);
  const table = i => ({ size: u32(tables, 12 * i), offset: u32(tables, 12 * i + 8) });
  const look = i => ({ key: u32(tables, 12 * count + 16 * i), lt: u32(tables, 12 * count + 16 * i + 8), gt: u32(tables, 12 * count + 16 * i + 12) });
  for (let i = 0; i < Math.min(count, 8); i++) if (table(i).offset + table(i).size > src.size) return null;
  function find(key) {
    for (let i = 0, n = 0; n <= count; n++) {
      const l = look(i);
      if (l.key === key) return i;
      i = ((l.key | 0) < (key | 0) ? l.lt : l.gt) >>> 4;      // signed comparison, as in the game
      if (!i) return null;
    }
    return null;
  }
  async function entry(i) {
    const { size, offset } = table(i);
    const d = copy(await src.read(offset, size));
    crypt(d, keyA, keyB);                                     // the key stream restarts for every entry
    return inflateZlib(d.subarray(4, size), u32(d, 0));
  }
  const entries = [], stagesSeen = new Map();
  for (let i = 0; i < count; i++) {
    const s = stageOfCnfKey(look(i).key);
    if (s === null || table(i).size > 0x10000) continue;
    let text;
    try { const d = await entry(i); text = latin1.decode(d); } catch (e) { continue; }
    if (text[0] !== '.' || /[^\t\n\r\x20-\x7e]/.test(text)) continue;
    const names = cnfFiles(text);
    // the stage's own name appears in its files (w01s01a.rlc, w01s01a.nav) or slot names (dynamic_map_w01s01a)
    const candidates = new Set();
    for (const n of names) candidates.add(n.replace(/\.[^.]*$/, ''));
    for (const m of text.matchAll(/^\.slot\s+(\S+)/gm)) for (let p = m[1]; p.includes('_'); p = p.slice(p.indexOf('_') + 1)) candidates.add(p);
    const name = [...candidates].find(c => strcode(c) === s) || 'stage_' + hex6(s);
    if (stagesSeen.has(name)) continue;
    stagesSeen.set(name, s);
    entries.push({ path: name + '/data.cnf', size: null, index: i });
    for (const n of names) {
      const id = fileId(n), j = id === null ? null : find(lookupKey(s, id));
      if (j !== null) entries.push({ path: name + '/' + n, size: null, index: j });
    }
  }
  if (!entries.length) return null;
  const byPath = new Map(entries.map(e => [e.path, e]));
  return {
    kind: 'pw-stagedat', label: 'Peace Walker stage data', entries,
    async read(path) { const e = byPath.get(path); if (!e) throw new Error('no such file: ' + path); return entry(e.index); },
  };
}

// ---- Peace Walker HD: SLOT.DAT + SLOT.KEY -------------------------------------------------------------------------
/** SLOT.KEY: 12-byte key {k0, k1, k2}, then 20-byte records {u32 A, u32 B, u32 slot hash, u32, u32}: slot = sectors
 *  A & 0xFFFFF .. B & 0xFFFFF (0x1000 bytes) of SLOT.DAT. A slot (key stream restarted) = {u32 0x00100004, 0,
 *  u32 compressed size, u32 size} + zlib; inside, {u32 count, 0} + 16-byte records {u32 id, 0, u32 offset, 0} up to
 *  7F000000, file data from 0x1000. Slot folders are named <index>_<hash>, as pw_slot_unpack.py names them. */
export async function openPwSlot(src, keyBytes) {
  const SECTOR = 0x1000;
  if (!keyBytes || keyBytes.length < 32 || (keyBytes.length - 12) % 20) return null;
  const v = (u32(keyBytes, 0) ^ u32(keyBytes, 4)) >>> 0;
  const keyA = (v | ((v ^ 0x6576) << 16)) >>> 0, keyB = Math.imul(v, u32(keyBytes, 8)) >>> 0;
  const recs = [];
  for (let o = 12; o + 20 <= keyBytes.length; o += 20)
    recs.push({ start: (u32(keyBytes, o) & 0xFFFFF) * SECTOR, end: (u32(keyBytes, o + 4) & 0xFFFFF) * SECTOR, hash: u32(keyBytes, o + 8) });
  /** Decrypted bytes [0, n) of a slot (the key stream starts at the slot). */
  const head = async (r, n) => { const d = copy(await src.read(r.start, Math.min(n, r.end - r.start))); crypt(d, keyA, keyB); return d; };
  const entries = [], digits = String(recs.length - 1).length < 4 ? 4 : String(recs.length - 1).length;
  let bad = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.end <= r.start || r.end > align(src.size, SECTOR)) { bad++; continue; }
    let n = 0x2000, d = await head(r, n);
    if (u32(d, 0) !== 0x00100004 || u32(d, 8) > r.end - r.start) {
      if (++bad === 8 && i === 7) return null;               // not this key, or not a Peace Walker SLOT.DAT
      continue;
    }
    const comp = u32(d, 8);
    // the file table is the first 0x1000 bytes of the slot: inflate just that much
    let fed = d.length;
    const table = await inflateHead(d.subarray(16, Math.min(d.length, 16 + comp)), SECTOR, async () => {
      if (fed >= 16 + comp) return null;
      n *= 4; const more = await head(r, Math.min(n, 16 + comp)); const piece = more.subarray(fed, Math.min(more.length, 16 + comp)); fed = more.length; return piece;
    });
    r.size = u32(d, 12); r.comp = comp;
    const files = [];
    for (let o = 8; o + 16 <= Math.min(table.length, SECTOR); o += 16) {
      const id = u32(table, o), off = u32(table, o + 8);
      files.push({ id, off });
      if (id === 0x7F000000) break;
    }
    const dir = String(i).padStart(digits, '0') + '_' + r.hash.toString(16).padStart(8, '0');
    for (let j = 0; j + 1 < files.length; j++) {
      const f = files[j];
      if (f.id >>> 24 === 0x7F) continue;
      entries.push(hashedEntry(dir, f.id, PW_EXT, files[j + 1].off - f.off, { slot: i, off: SECTOR + f.off }));
    }
  }
  if (!entries.length || bad > recs.length / 2) return null;
  const byPath = new Map(entries.map(e => [e.path, e]));
  const loaded = new Map();
  async function slot(i) {
    if (loaded.has(i)) { const d = loaded.get(i); loaded.delete(i); loaded.set(i, d); return d; }
    const r = recs[i];
    const d = await head(r, align(16 + r.comp, 4));
    const data = inflateZlib(d.subarray(16, 16 + r.comp), r.size);
    loaded.set(i, data);
    while (loaded.size > 4) loaded.delete(loaded.keys().next().value);
    return data;
  }
  return {
    kind: 'pw-slot', label: 'Peace Walker slot data', entries,
    async read(path) { const e = byPath.get(path); if (!e) throw new Error('no such file: ' + path); return (await slot(e.slot)).slice(e.off, e.off + e.size); },
    forget() { loaded.clear(); },
  };
}

// ---- PSARC (MGS3 HD) ----------------------------------------------------------------------------------------------
/** PlayStation archive: big-endian header {'PSAR', u16 major, u16 minor, 'zlib', u32 TOC length, u32 entry size,
 *  u32 files, u32 block size, u32 flags}; entries {md5[16], u32 first block, u40 size, u40 offset}, then the
 *  compressed size of every block (0 = a full raw block). Entry 0 is the manifest: the other entries' paths. */
export async function openPsarc(src) {
  const h = await src.read(0, 32);
  if (latin1.decode(h.subarray(0, 4)) !== 'PSAR') return null;
  const comp = latin1.decode(h.subarray(8, 12)), tocLen = be32(h, 12), esz = be32(h, 16), nfiles = be32(h, 20);
  const bsize = be32(h, 24), flags = be32(h, 28);
  if (comp !== 'zlib' || (flags & 4) || esz < 30 || tocLen > src.size) return null;     // LZMA or encrypted TOC
  const toc = await src.read(32, tocLen - 32);
  const u40 = o => toc[o] * 2 ** 32 + be32(toc, o + 1);
  const files = [];
  for (let i = 0; i < nfiles; i++) { const o = i * esz; files.push({ block: be32(toc, o + 16), size: u40(o + 20), offset: u40(o + 25) }); }
  const width = bsize <= 0x10000 ? 2 : bsize <= 0x1000000 ? 3 : 4;
  const sizesAt = nfiles * esz, nblocks = Math.floor((toc.length - sizesAt) / width);
  const blockSize = b => { let v = 0; for (let k = 0; k < width; k++) v = v * 256 + toc[sizesAt + b * width + k]; return v; };
  async function readFile(f) {
    const blocks = [];
    let span = 0;
    for (let b = f.block, left = f.size; left > 0 && b < nblocks; b++) {
      const z = blockSize(b), plain = Math.min(bsize, left);
      blocks.push({ z: z || bsize, plain }); span += z || bsize; left -= plain;
    }
    const raw = await src.read(f.offset, span), out = new Uint8Array(f.size);
    let i = 0, o = 0;
    for (const b of blocks) {
      const piece = raw.subarray(i, i + b.z);
      // a block whose stored size equals its plain size is stored raw; the others are zlib streams
      out.set(b.z === b.plain || piece[0] !== 0x78 ? piece.subarray(0, b.plain) : inflateZlib(piece, b.plain), o);
      i += b.z; o += b.plain;
    }
    return out;
  }
  const names = latin1.decode(await readFile(files[0])).split('\n');
  const entries = [];
  for (let i = 1; i < files.length && i - 1 < names.length; i++) {
    const path = names[i - 1].replace(/^\/+/, '');
    if (path) entries.push({ path, size: files[i].size, file: files[i] });
  }
  const byPath = new Map(entries.map(e => [e.path, e]));
  return {
    kind: 'psarc', label: 'PlayStation archive', entries,
    async read(path) { const e = byPath.get(path); if (!e) throw new Error('no such file: ' + path); return readFile(e.file); },
  };
}

// ---- detection --------------------------------------------------------------------------------------------------
/** Which reader a file name calls for (the contents decide in the end: every reader checks its format). */
export function packKind(name) {
  const n = name.toLowerCase();
  if (n === '_zar' || n.endsWith('.zar')) return 'zar';
  if (/^stage(_\w+)?\.dat$/.test(n)) return 'ps2-stage';
  if (/^slot(_\w+)?\.dat$/.test(n)) return 'slot';
  if (n === 'stagedat.pdt' || n === 'stagedata.pdt') return 'pw-stagedat';
  if (n.endsWith('.psarc')) return 'psarc';
  return null;
}
/** Open a container. `sibling(name)` returns the bytes of a file beside it (SLOT.KEY), or null. */
export async function openPack(kind, src, sibling) {
  switch (kind) {
    case 'zar': return openZar(src);
    case 'ps2-stage': return openPs2Stage(src);
    case 'slot': {
      const key = await sibling('SLOT.KEY');
      return key ? openPwSlot(src, key) : openPlainSlot(src);
    }
    case 'pw-stagedat': return openPwStagedat(src);
    case 'psarc': return openPsarc(src);
  }
  return null;
}
