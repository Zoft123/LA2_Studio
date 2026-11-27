// Offline check of Peace Walker (PS3 HD) LA3 + TXP support: software-renders .la3 files with LA2 Studio's own
// parser, texture pool and playback engine (no browser), writing PNG contact sheets.
//
//   node tests/pw-render.mjs <out folder> <folder> [<folder> ...] [--limit N] [--no-png]
//
// Folders are searched recursively for .la3 files (loose, e.g. a SLOT.DAT unpack, or inside .dar archives). Each
// layout gets the TXP textures of its folder and the folder above: loose .txp files and those in Peace Walker
// .qar archives (stage/<name>/cache0.qar, resident0.qar, ...). Sheet: initial state, then the middle frame of
// up to five actions.
import fs from 'node:fs';
import path from 'node:path';
import { openLa3, isLa3 } from '../js/formats/la3.js';
import { TexturePool } from '../js/formats/textures.js';
import { readDar, readPwQar } from '../js/formats/archives.js';
import { Scene, Timeline } from '../js/engine/scene.js';
import { png, rasterise, sheet } from './raster.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const limit = +opt('--limit', Infinity);
const noPng = args.includes('--no-png') && !!args.splice(args.indexOf('--no-png'), 1);
const [out, ...roots] = args;
if (!out || !roots.length) { console.error('usage: node tests/pw-render.mjs <out folder> <folder> ... [--limit N] [--no-png]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const read = p => new Uint8Array(fs.readFileSync(p));
const pools = new Map();
/** TXPs of one folder (loose and in its PW QARs). */
function folderPool(dir) {
  if (pools.has(dir)) return pools.get(dir);
  const pool = new TexturePool();
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f), low = f.toLowerCase();
    try {
      if (low.endsWith('.qar')) for (const e of readPwQar(read(p)) || []) { if (e.name.toLowerCase().endsWith('.txp')) pool.addTxp(e.data); }
      else if (low.endsWith('.txp')) pool.addTxp(read(p));
    } catch (e) { /* not a PW archive / TXP */ }
  }
  pools.set(dir, pool);
  return pool;
}
function textures(dir) {
  const list = [folderPool(dir), folderPool(path.dirname(dir))];
  const find = h => { for (const pool of list) { const i = pool.info(h); if (i && pool.raw(h)) return [pool, i]; } return [null, null]; };
  const images = new Map();
  return {
    lookup(h) {
      const [, i] = find(h);
      return i ? { w: i.w, h: i.h, ox: i.ox, oy: i.oy, iw: i.img.w, ih: i.img.h, u0: i.u0, v0: i.v0, uw: i.uw, vh: i.vh, lw: i.lw, lh: i.lh } : null;
    },
    image(h) {
      const [pool, i] = find(h);
      if (!i) return null;
      const k = i.tri + '|' + i.imgOff;
      if (!images.has(k)) { const r = pool.raw(h); images.set(k, r ? { w: r.w, h: r.h, rgba: r.data } : null); }
      return images.get(k);
    },
  };
}

function* layouts(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name), low = e.name.toLowerCase();
    if (e.isDirectory()) yield* layouts(p);
    else if (low.endsWith('.la3')) yield { dir, name: e.name, bytes: () => read(p) };
    else if (low.endsWith('.dar')) {
      let d;
      try { d = readDar(read(p)); } catch (x) { continue; }
      const data = read(p);
      for (const en of d.entries) if (en.name.toLowerCase().endsWith('.la3'))
        yield { dir, name: e.name + '_' + en.name, bytes: () => data.slice(en.offset, en.offset + en.size) };
    }
  }
}

let total = 0, rendered = 0, failed = 0, skipped = 0, texRefs = 0, missingTex = 0;
const missing = new Map();
for (const root of roots) for (const f of layouts(root)) {
  if (total >= limit) break;
  const bytes = f.bytes();
  if (!isLa3(bytes)) continue;
  total++;
  if (bytes[3] !== 7) { skipped++; continue; }
  try {
    const la = openLa3(bytes);
    const tx = textures(f.dir);
    texRefs += la.texKeys.length;
    for (const k of la.texKeys) if (!tx.lookup(k) || !tx.image(k)) {
      missingTex++;
      const t = Math.floor(k / 0x1000000).toString(16).padStart(6, '0');
      missing.set(t, (missing.get(t) || 0) + 1);
    }
    const scene = new Scene(la, tx);
    if (!noPng) {
      // many PW layouts start hidden and are shown by their actions: frame what every sampled frame draws
      const shots = [scene.primitives()];
      for (let a = 0; a < la.actions.length && shots.length < 6; a++) {
        const tl = new Timeline(la, a, 'once');
        scene.setTimeline(tl);
        const n = tl.length();
        if (!n) continue;
        scene.seek(Math.round(n / 2));
        shots.push(scene.primitives());
      }
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const prims of shots) for (const p of prims) for (const [x, y] of p.pts) {
        lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
      }
      if (!isFinite(lo[0])) { lo = [0, 0]; hi = [64, 64]; }
      const b = { x: lo[0] - 8, y: lo[1] - 8, w: hi[0] - lo[0] + 16, h: hi[1] - lo[1] + 16 };
      const scale = Math.min(2, 360 / Math.max(b.w, b.h));
      const s = sheet(shots.map(prims => rasterise(prims, b, scale, tx)));
      fs.writeFileSync(path.join(out, path.basename(f.dir) + '_' + f.name.replace(/\.la3$/i, '') + '.png'), png(s.w, s.h, s.rgba));
    } else {
      for (let a = 0; a < la.actions.length; a++) {   // still play every action
        const tl = new Timeline(la, a, 'once');
        scene.setTimeline(tl);
        scene.seek(tl.length());
        scene.primitives();
      }
    }
    rendered++;
  } catch (e) { failed++; console.log('FAIL', path.join(f.dir, f.name), e.stack.split('\n').slice(0, 3).join(' | ')); }
}
console.log(`${rendered}/${total} layouts rendered (${skipped} older LA3 versions skipped, ${failed} failed), ` +
  `${texRefs - missingTex}/${texRefs} texture references resolved in their folder or the one above`);
if (missing.size) console.log('missing TXPs:', [...missing].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t} x${n}`).join(', '));
