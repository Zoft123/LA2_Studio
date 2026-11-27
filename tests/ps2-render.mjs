// Offline check of PS2 (MGS3 / MGO1) LA2 + TRI support: software-renders LA2 files with Libla Studio's own parser,
// texture pool and playback engine (no browser), writing PNG contact sheets.
//
//   node tests/ps2-render.mjs <out folder> <stage folder> [<stage folder> ...]
//
// Each LA2 is drawn with the TRIs of its own folder: its initial state, then frames of every action.
// The rasteriser mirrors gl.js: vertex colour x nearest texel, normal / add / sub / none blending.
import fs from 'node:fs';
import path from 'node:path';
import { LA2 } from '../js/formats/la2.js';
import { TexturePool } from '../js/formats/textures.js';
import { Scene, Timeline } from '../js/engine/scene.js';
import { ctxrDirs, ctxrHash } from '../js/formats/ctxr.js';
import { png, rasterise, sheet } from './raster.mjs';

const [out, ...roots] = process.argv.slice(2);
if (!out || !roots.length) { console.error('usage: node tests/ps2-render.mjs <out folder> <stage folder> ...'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

/** Texture source for Scene (lookup) and the rasteriser (image), like Library. */
function textures(dir) {
  const pool = new TexturePool();
  const hd = new Map();      // PS3 port: <hash>.ctxr HD textures (see Library.pool)
  for (const d of ctxrDirs(dir)) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) { const h = ctxrHash(f); if (h !== null && !hd.has(h)) hd.set(h, path.join(d, f)); }
  }
  for (const f of fs.readdirSync(dir)) {
    const m = /^(?:00)?([0-9a-f]{6})\.tri$/i.exec(f);
    if (m) try { pool.addTri(new Uint8Array(fs.readFileSync(path.join(dir, f))), parseInt(m[1], 16), hd); } catch (e) { /* not a TRI */ }
  }
  pool.hd = hd;
  const load = i => { if (i && i.hdSrc && !i.hd) pool.setHd(i, new Uint8Array(fs.readFileSync(i.hdSrc))); return i; };
  const images = new Map();
  return {
    pool,
    lookup(h) {
      const i = load(pool.info(h));
      return i ? { w: i.w, h: i.h, ox: i.ox, oy: i.oy, iw: i.img.w, ih: i.img.h, u0: i.u0, v0: i.v0, uw: i.uw, vh: i.vh } : null;
    },
    image(h) {
      const i = load(pool.info(h));
      if (!i) return null;
      const k = i.tri + '|' + i.imgOff;
      if (!images.has(k)) { const r = pool.raw(h); images.set(k, r ? { w: r.w, h: r.h, rgba: r.data } : null); }
      return images.get(k);
    },
  };
}

let total = 0, rendered = 0, missingTex = 0, texRefs = 0;
for (const root of roots) {
  const dirs = [root, ...fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name))];
  for (const dir of dirs) {
    const la2s = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.la2'));
    if (!la2s.length) continue;
    const tx = textures(dir);
    for (const f of la2s) {
      total++;
      try {
        const la = new LA2(new Uint8Array(fs.readFileSync(path.join(dir, f))));
        texRefs += la.texKeys.length;
        missingTex += la.texKeys.filter(k => !tx.lookup(k) || !tx.image(k)).length;
        const scene = new Scene(la, tx);
        const b = scene.bounds();
        const scale = Math.min(2, 360 / Math.max(b.w, b.h));
        const frames = [rasterise(scene.primitives(), b, scale, tx)];
        for (let a = 0; a < la.actions.length && frames.length < 6; a++) {
          const tl = new Timeline(la, a, 'once');
          scene.setTimeline(tl);
          const n = tl.length();
          if (!n) continue;
          scene.seek(Math.round(n / 2));
          frames.push(rasterise(scene.primitives(), b, scale, tx));
        }
        const s = sheet(frames);
        fs.writeFileSync(path.join(out, path.basename(dir) + '_' + f.replace(/\.la2$/i, '') + '.png'), png(s.w, s.h, s.rgba));
        rendered++;
      } catch (e) { console.log('FAIL', path.join(dir, f), e.stack.split('\n').slice(0, 3).join(' | ')); }
    }
  }
}
console.log(`${rendered}/${total} layouts rendered, ${texRefs - missingTex}/${texRefs} texture references resolved in their own folder`);
