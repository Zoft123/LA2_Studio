// Offline check of Metal Gear Solid: Portable Ops (PSP) LA2 + TXP support: software-renders the layouts of each
// stage with Libla Studio's own parser, texture pool and playback engine (no browser), writing PNG contact sheets.
//
//   node tests/po-render.mjs <out folder> <stage folder> [<stage folder> ...] [--limit N] [--no-png]
//
// A stage folder is searched recursively. Layouts: loose .la2 and those inside .dar archives. Textures: every TXP of
// the stage, loose (an extracted cache.qar, named by file: their hash is StrCode24 of the name) or inside Portable
// Ops .qar archives (0x80-aligned). A layout counts as Portable Ops when its texture table resolves to TXP textures
// (Library.isPspLayout); it is then keyed and mapped like the app does (LA2.usePspTextures).
import fs from 'node:fs';
import path from 'node:path';
import { LA2 } from '../js/formats/la2.js';
import { TexturePool } from '../js/formats/textures.js';
import { readDar, readPwQar } from '../js/formats/archives.js';
import { txpTexKey } from '../js/formats/txp.js';
import { strcode } from '../js/core/bin.js';
import { Scene, Timeline } from '../js/engine/scene.js';
import { png, rasterise, sheet } from './raster.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const limit = +opt('--limit', Infinity);
const noPng = args.includes('--no-png') && !!args.splice(args.indexOf('--no-png'), 1);
const [out, ...roots] = args;
if (!out || !roots.length) { console.error('usage: node tests/po-render.mjs <out folder> <stage folder> ... [--limit N] [--no-png]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const read = p => new Uint8Array(fs.readFileSync(p));
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
/** Every TXP of a stage folder in one pool. */
function stagePool(dir) {
  const pool = new TexturePool();
  for (const p of walk(dir)) {
    const low = p.toLowerCase();
    try {
      if (low.endsWith('.qar')) for (const e of readPwQar(read(p)) || []) { if (e.name.toLowerCase().endsWith('.txp')) pool.addTxp(e.data, e.id & 0xFFFFFF); }
      else if (low.endsWith('.txp')) pool.addTxp(read(p), strcode(path.basename(p).replace(/\.[^.]*$/, '')));
    } catch (e) { /* not a TXP / QAR */ }
  }
  return pool;
}
function textures(pool) {
  const images = new Map();
  const has = h => { const i = pool.info(h); return i && pool.raw(h) ? i : null; };
  return {
    has,
    lookup(h) {
      const i = has(h);
      return i ? { w: i.w, h: i.h, ox: i.ox, oy: i.oy, iw: i.img.w, ih: i.img.h, u0: i.u0, v0: i.v0, uw: i.uw, vh: i.vh, lw: i.lw, lh: i.lh } : null;
    },
    image(h) {
      const i = has(h);
      if (!i) return null;
      const k = i.tri + '|' + i.imgOff;
      if (!images.has(k)) { const r = pool.raw(h); images.set(k, r ? { w: r.w, h: r.h, rgba: r.data } : null); }
      return images.get(k);
    },
  };
}
function* layouts(dir) {
  for (const p of walk(dir)) {
    const low = p.toLowerCase();
    if (low.endsWith('.la2')) yield { name: path.relative(dir, p), bytes: () => read(p) };
    else if (low.endsWith('.dar')) {
      let d; const data = read(p);
      try { d = readDar(data); } catch (x) { continue; }
      for (const en of d.entries) if (en.name.toLowerCase().endsWith('.la2'))
        yield { name: path.relative(dir, p) + '_' + en.name, bytes: () => data.slice(en.offset, en.offset + en.size) };
    }
  }
}

let total = 0, rendered = 0, failed = 0, psp = 0, texRefs = 0, missingTex = 0;
const missing = new Map();
for (const root of roots) {
  // a stage folder holds _zarFOLDER/ (the unpacked .zar) and/or *_extracted/ folders; otherwise its subfolders are stages
  const isStage = d => fs.readdirSync(d).some(n => n === '_zarFOLDER' || /_extracted$|\.(dar|qar)$/i.test(n));
  const stages = isStage(root) ? [root] : fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => path.join(root, e.name)).filter(isStage);
  for (const stage of stages) {
    const tx = textures(stagePool(stage));
    for (const f of layouts(stage)) {
      if (total >= limit) break;
      total++;
      try {
        const la = new LA2(f.bytes());
        // the same test as Library.isPspLayout
        const found = la.tex_tbl.filter(([h, t]) => tx.has(txpTexKey(h, t))).length;
        if (!la.ps2 && la.le && la.version === 0x10008 && la.tex_tbl.length && found * 2 >= la.tex_tbl.length && found) { la.usePspTextures(); psp++; }
        texRefs += la.texKeys.length;
        for (const k of la.texKeys) if (!tx.lookup(k)) {
          missingTex++;
          const t = Math.floor(k / 0x1000000).toString(16).padStart(6, '0');
          missing.set(t, (missing.get(t) || 0) + 1);
        }
        const scene = new Scene(la, tx);
        const shots = [scene.primitives()];
        for (let a = 0; a < la.actions.length && (noPng || shots.length < 6); a++) {
          const tl = new Timeline(la, a, 'once');
          scene.setTimeline(tl);
          const n = tl.length();
          scene.seek(noPng ? n : Math.round(n / 2));
          const prims = scene.primitives();
          if (!noPng && n) shots.push(prims);
        }
        if (!noPng) {
          let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
          for (const prims of shots) for (const p of prims) for (const [x, y] of p.pts) {
            lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
          }
          if (!isFinite(lo[0])) { lo = [0, 0]; hi = [64, 64]; }
          const b = { x: lo[0] - 8, y: lo[1] - 8, w: hi[0] - lo[0] + 16, h: hi[1] - lo[1] + 16 };
          const scale = Math.min(2, 360 / Math.max(b.w, b.h));
          const s = sheet(shots.map(prims => rasterise(prims, b, scale, tx)));
          fs.writeFileSync(path.join(out, path.basename(stage) + '_' + f.name.replace(/[\\/]/g, '_').replace(/\.la2$/i, '') + '.png'), png(s.w, s.h, s.rgba));
        }
        rendered++;
      } catch (e) { failed++; console.log('FAIL', path.join(stage, f.name), e.stack.split('\n').slice(0, 3).join(' | ')); }
    }
  }
}
console.log(`${rendered}/${total} layouts rendered (${failed} failed), ${psp} recognised as Portable Ops, ` +
  `${texRefs - missingTex}/${texRefs} texture references resolved in their stage`);
if (missing.size) console.log('missing TXPs:', [...missing].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t} x${n}`).join(', '));
