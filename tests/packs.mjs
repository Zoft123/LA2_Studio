// Packed game data on small synthetic files, built the way the games store them (encrypted / compressed where they
// are): Portable Ops _zar (and rebuilding it), MGS3 / MGO1 STAGE.DAT and SLOT.DAT, Peace Walker STAGEDAT.PDT and
// SLOT.DAT + SLOT.KEY, PSARC; and PackFS showing them as folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writer, latin1, strcode } from '../js/core/bin.js';
import { writeDar, readDar } from '../js/formats/archives.js';
import { zlibSync } from '../js/vendor/fflate.js';
import { openZar, openPs2Stage, openPlainSlot, openPwStagedat, openPwSlot, openPsarc, packKind, cnfFiles } from '../js/formats/packs.js';
import { PackFS } from '../js/app/packfs.js';

const KEY_MUL = 0x02E90EDD;
const src = bytes => ({ size: bytes.length, reads: 0, async read(o, n) { this.reads++; return bytes.slice(o, Math.min(o + n, bytes.length)); } });
/** The games' stream cipher (XOR, so it also encrypts); returns the next key. */
function crypt(bytes, key, step) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 0; o + 4 <= bytes.length; o += 4) { dv.setUint32(o, (dv.getUint32(o, true) ^ key) >>> 0, true); key = (Math.imul(key, KEY_MUL) + step) >>> 0; }
  return key;
}
const pad = (w, a) => { while (w.length % a) w.u8(0); return w; };
const text = s => latin1.encode(s);
const fill = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xFF);

test('Portable Ops _zar: u32 size + zlib DAR, read in place and rebuilt', async () => {
  const files = [{ name: 'data.cnf', data: text('.nocache\n.cache\ncache.dar\n') }, { name: 'cache.dar', data: fill(300, 1) }];
  const dar = writeDar(files, true);
  const z = zlibSync(dar), zar = new Uint8Array(4 + z.length);
  new DataView(zar.buffer).setUint32(0, dar.length, true); zar.set(z, 4);
  const pack = await openZar(src(zar));
  assert.deepEqual(pack.entries.map(e => [e.path, e.size]), [['data.cnf', 26], ['cache.dar', 300]]);
  assert.deepEqual([...await pack.read('cache.dar')], [...files[1].data]);
  const again = await openZar(src(pack.rebuild({ 'cache.dar': fill(10, 9) })));
  assert.deepEqual([...await again.read('cache.dar')], [...fill(10, 9)]);
  assert.deepEqual([...await again.read('data.cnf')], [...files[0].data]);
  assert.equal(await openZar(src(fill(64, 3))), null, 'not a _zar');
});

/** MGS3 / MGO1 STAGE.DAT with one stage and one compressed section holding two files. */
function ps2Stage() {
  const w0 = 0x13579BDF, step = (w0 ^ 0xF0F0) >>> 0, name = 'm001a';
  const files = [[0x5f << 24 | 0x123456, fill(40, 2)], [0x03 << 24 | 0x654321, fill(24, 5)]];
  const section = new Uint8Array(64); section.set(files[0][1], 0); section.set(files[1][1], 40);
  // the section: zlib (header 78 9C), stored with its first u16 lowered by 0x8F3 and encrypted with the key that
  // its encrypted first u16 selects
  const plain = zlibSync(section), k = 0x2468;
  const enc = new Uint8Array(Math.ceil(plain.length / 4) * 4); enc.set(plain);
  const lo = ((enc[0] | enc[1] << 8) - 0x8F3) & 0xFFFF; enc[0] = lo & 0xFF; enc[1] = lo >> 8;
  crypt(enc, (((k ^ 0x6576) << 16) | k) >>> 0, Math.imul(k, 0x116) >>> 0);
  assert.equal((enc[0] | enc[1] << 8) ^ 0x9385, k);
  // the stage TOC: section 7F000002 (64 bytes), 7E (compressed size / offset 0), two files, end
  const toc = new Writer(true).u32(5).u32(0x7F000002).u32(64).u32(0x7E000000 | enc.length).u32(0)
    .u32(files[0][0]).u32(0).u32(files[1][0]).u32(40).u32(0x7F000000).u32(0);
  pad(toc, 0x800);
  const t1 = strcode(name);
  const tocBytes = toc.result(); crypt(tocBytes, (Math.imul(t1, 129) + w0 + 0xA78925D9) >>> 0, (Math.imul(t1, 129) + 0x7A88FB59) >>> 0);
  // header + directory (sector 0), stage at sector 1
  const head = new Writer(true).u32(0).u32(0).u16(1).u16(0).u32(0);
  head.bytes(text(name.padEnd(16, '\0'))).u32(1);
  const hb = head.result(); crypt(hb.subarray(4), w0, step); new DataView(hb.buffer).setUint32(0, w0, true);
  const out = new Writer(true).bytes(hb); pad(out, 0x800); out.bytes(tocBytes).bytes(enc); pad(out, 0x800);
  return { bytes: out.result(), files };
}
test('MGS3 / MGO1 STAGE.DAT: encrypted directory, TOC and zlib section', async () => {
  const { bytes, files } = ps2Stage();
  const pack = await openPs2Stage(src(bytes));
  assert.deepEqual(pack.entries.map(e => [e.path, e.size, e.hash]), [['m001a/123456.la2', 40, 0x123456], ['m001a/654321.tri', 24, 0x654321]]);
  assert.deepEqual([...await pack.read('m001a/654321.tri')], [...files[1][1]]);
  assert.equal(await openPs2Stage(src(fill(0x2000, 1))), null);
});

/** Plain slots (MGS3 / MGO1 SLOT.DAT, Portable Ops slot.dat): two slots, one with a TXP (Portable Ops types). */
function plainSlot(psp) {
  const out = new Writer(true).u32(0x43000000).u16(1).u16(1).u16(2).u16(37).u32(1); pad(out, 0x800);
  const slot = (id, data) => {
    const toc = new Writer(true).u32(3).u32(0x7F000002).u32(data.length).u32(id).u32(0).u32(0x7F000000).u32(0);
    pad(toc, 0x800); out.bytes(toc.result()).bytes(data); pad(out, 0x800);
  };
  slot(0x5f << 24 | 0xABCDEF, fill(100, 3));
  slot((psp ? 0x14 : 0x03) << 24 | 0x111111, fill(3000, 4));
  return out.result();
}
test('plain SLOT.DAT: slots in sequence, uncompressed; TXPs mark Portable Ops', async () => {
  const ps2 = await openPlainSlot(src(plainSlot(false)));
  assert.equal(ps2.kind, 'ps2-slot');
  assert.deepEqual(ps2.entries.map(e => [e.path, e.size]), [['slot_000/abcdef.la2', 100], ['slot_001/111111.tri', 3000]]);
  assert.deepEqual([...await ps2.read('slot_001/111111.tri')], [...fill(3000, 4)]);
  const psp = await openPlainSlot(src(plainSlot(true)));
  assert.equal(psp.kind, 'psp-slot');
  assert.equal(psp.entries[1].path, 'slot_001/111111.txp');
  assert.equal(psp.entries[1].hash, 0x111111);
});

/** Peace Walker STAGEDAT.PDT with one stage: data.cnf, cache.dar, cache0.qar. */
function pwStagedat() {
  const [sA, sB, sC] = [0x11111111, 0x22222222, 0x33333333];
  const v = (sA ^ sB) >>> 0, keyA = (v | ((v ^ 0x6576) << 16)) >>> 0, keyB = Math.imul(v, sC) >>> 0;
  const stage = 'w01s01a', s = strcode(stage);
  const id = (type, base) => ((type << 24) ^ strcode(base)) >>> 0;
  const key = fid => (~(((s >>> 4) ^ (s << 4)) ^ 0x10EA) ^ fid) >>> 0;
  const cnf = text('.nocache\n.cache\n.slot lang_re_w01s01a 1 4096\n.endslot\n@cache0.qar\ncache.dar\nw01s01a.rlc\n');
  const files = [[key(id(242, 'data')), cnf], [key(id(240, 'cache')), fill(500, 6)], [key(id(241, 'cache0')), fill(90, 7)]];
  // binary search tree over the signed keys (lt / gt = child index * 16), node 0 = root
  const nodes = files.map(([k]) => ({ k, lt: 0, gt: 0 }));
  for (let i = 1; i < nodes.length; i++) for (let j = 0; ;) {
    const side = (nodes[j].k | 0) < (nodes[i].k | 0) ? 'lt' : 'gt';
    if (!nodes[j][side]) { nodes[j][side] = i * 16; break; }
    j = nodes[j][side] / 16;
  }
  const blobs = files.map(([, data]) => {
    const z = zlibSync(data), b = new Writer(true).u32(data.length).bytes(z); pad(b, 4);
    const r = b.result(); crypt(r, keyA, keyB); return r;
  });
  const n = files.length, dataAt = 0x1000;
  const tables = new Writer(true);
  let at = dataAt;
  for (const b of blobs) { tables.u32(b.length).u32(0).u32(at); at += Math.ceil(b.length / 0x800) * 0x800; }
  nodes.forEach((nd, i) => tables.u32(nd.k).u32(i).u32(nd.lt).u32(nd.gt));
  const head = new Writer(true).u32(0).u32(0).u32(0).u16(n).u16(0).u32(32 + 12 * n).bytes(tables.result());
  const hb = head.result(); crypt(hb, keyA, keyB);
  const out = new Writer(true).u32(sA).u32(sB).u32(sC).bytes(hb); pad(out, 0x1000);
  for (const b of blobs) { out.bytes(b); pad(out, 0x800); }
  return { bytes: out.result(), files };
}
test('Peace Walker STAGEDAT.PDT: stages found by their data.cnf, files by lookup key', async () => {
  const { bytes, files } = pwStagedat();
  const pack = await openPwStagedat(src(bytes));
  assert.deepEqual(pack.entries.map(e => e.path), ['w01s01a/data.cnf', 'w01s01a/cache0.qar', 'w01s01a/cache.dar'],
    'the stage is named from its config (w01s01a.rlc); the .rlc itself is not stored');
  assert.deepEqual([...await pack.read('w01s01a/cache.dar')], [...files[1][1]]);
  assert.deepEqual(cnfFiles('.cache\n.vram a.txp\n@q.qar\n?x.afp\nf.gcx\n'), ['a.txp', 'q.qar', 'x.afp', 'f.gcx']);
});

/** Peace Walker SLOT.DAT + SLOT.KEY with one slot of two files. */
function pwSlot() {
  const key = new Writer(true).u32(0xAAAA5555).u32(0x12345678).u32(0x0F0F0F0F);
  const v = (0xAAAA5555 ^ 0x12345678) >>> 0, keyA = (v | ((v ^ 0x6576) << 16)) >>> 0, keyB = Math.imul(v, 0x0F0F0F0F) >>> 0;
  const data = new Writer(true).u32(3).u32(0).u32(0x5e << 24 | 0x0A0B0C).u32(0).u32(0).u32(0).u32(0x14 << 24 | 0x0D0E0F).u32(0).u32(64).u32(0)
    .u32(0x7F000000).u32(0).u32(64 + 200).u32(0);
  pad(data, 0x1000); data.bytes(fill(64, 8)).bytes(fill(200, 9));
  const raw = data.result(), z = zlibSync(raw);
  const slot = new Writer(true).u32(0x00100004).u32(0).u32(z.length).u32(raw.length).bytes(z); pad(slot, 0x1000);
  const sb = slot.result(); crypt(sb, keyA, keyB);
  key.u32(1).u32(1 + sb.length / 0x1000).u32(0xDEADBEEF).u32(0).u32(0);
  const dat = new Uint8Array(0x1000 + sb.length); dat.set(sb, 0x1000);
  return { dat, key: key.result() };
}
test('Peace Walker SLOT.DAT: index from SLOT.KEY, encrypted zlib slots, file table inflated alone', async () => {
  const { dat, key } = pwSlot();
  const pack = await openPwSlot(src(dat), key);
  assert.deepEqual(pack.entries.map(e => [e.path, e.size]), [['0000_deadbeef/0a0b0c.la3', 64], ['0000_deadbeef/0d0e0f.txp', 200]]);
  assert.deepEqual([...await pack.read('0000_deadbeef/0d0e0f.txp')], [...fill(200, 9)]);
});

/** PSARC with a manifest and one two-block file (one zlib block, one stored raw). */
function psarc() {
  const bsize = 0x10000, file = new Uint8Array(bsize + 100);
  file.fill(7, 0, bsize); file.set(fill(100, 1), bsize);            // block 1 compresses; block 2 stays raw
  const manifest = text('/us/stage/title/cache/001234.la2');
  const z0 = zlibSync(manifest), z1 = zlibSync(file.subarray(0, bsize)), raw2 = file.subarray(bsize);
  const blocks = [z0.length, z1.length, raw2.length];
  const tocLen = 32 + 2 * 30 + 2 * blocks.length;
  const toc = new Writer(false);
  const entry = (block, size, offset) => { toc.bytes(new Uint8Array(16)).u32(block).u8(0).u32(size).u8(0).u32(offset); };
  entry(0, manifest.length, tocLen);
  entry(1, file.length, tocLen + z0.length);
  for (const b of blocks) toc.u16(b);
  const out = new Writer(false).bytes(text('PSAR')).u16(1).u16(4).bytes(text('zlib')).u32(tocLen).u32(30).u32(2).u32(bsize).u32(2);
  out.bytes(toc.result()).bytes(z0).bytes(z1).bytes(raw2);
  return { bytes: out.result(), file };
}
test('PSARC: manifest paths, zlib and raw blocks', async () => {
  const { bytes, file } = psarc();
  const pack = await openPsarc(src(bytes));
  assert.deepEqual(pack.entries.map(e => [e.path, e.size]), [['us/stage/title/cache/001234.la2', file.length]]);
  assert.deepEqual([...await pack.read('us/stage/title/cache/001234.la2')], [...file]);
});

test('PackFS: containers become folders; file names pick the reader', async () => {
  assert.deepEqual(['_zar', 'n01.zar', 'STAGE_2.DAT', 'stage.dat', 'SLOT_N.DAT', 'STAGEDAT.PDT', 'mgs3.psarc', 'BGM.PDT', 'cache.dar'].map(packKind),
    ['zar', 'zar', 'ps2-stage', 'ps2-stage', 'slot', 'pw-stagedat', 'psarc', null, null]);
  const { dat, key } = pwSlot();
  const files = new Map([['game/MGS/STAGE_2.DAT', ps2Stage().bytes], ['game/disc0/SLOT.DAT', dat], ['game/disc0/SLOT.KEY', key], ['game/x.la2', fill(8, 1)]]);
  const base = {
    name: 'game',
    async list() { return [...files].map(([path, b]) => ({ path, size: b.length })); },
    async read(p) { return files.get(p); },
    async readRange(p, o, n) { return files.get(p).slice(o, o + n); },
  };
  const fsys = new PackFS(base);
  const paths = (await fsys.list()).map(f => f.path);
  assert.ok(paths.includes('game/MGS/STAGE_2.DAT/m001a/123456.la2'));
  assert.ok(paths.includes('game/disc0/SLOT.DAT/0000_deadbeef/0a0b0c.la3'), 'Peace Walker slots need the SLOT.KEY beside them');
  assert.ok(paths.includes('game/x.la2'));
  assert.ok(fsys.isVirtual('game/MGS/STAGE_2.DAT/m001a/654321.tri') && !fsys.isVirtual('game/x.la2'));
  assert.equal(fsys.nameHash('game/disc0/SLOT.DAT/0000_deadbeef/0d0e0f.txp'), 0x0D0E0F);
  assert.equal((await fsys.read('game/disc0/SLOT.DAT/0000_deadbeef/0d0e0f.txp')).length, 200);
  assert.equal(fsys.container('game/MGS/STAGE_2.DAT/m001a/123456.la2').kind, 'ps2-stage');
  assert.equal(fsys.failed.length, 0);
});
