// Offline check of PS2 (MGS3 / MGO1) LA2 + TRI support: software-renders LA2 files with LA2 Studio's own parser,
// texture pool and playback engine (no browser), writing PNG contact sheets.
//
//   node tests/ps2-render.mjs <out folder> <stage folder> [<stage folder> ...]
//
// Each LA2 is drawn with the TRIs of its own folder: its initial state, then frames of every action.
// The rasteriser mirrors gl.js: vertex colour x nearest texel, normal / add / sub / none blending.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LA2 } from '../js/formats/la2.js';
import { TexturePool } from '../js/formats/textures.js';
import { Scene, Timeline } from '../js/engine/scene.js';

const [out, ...roots] = process.argv.slice(2);
if (!out || !roots.length) { console.error('usage: node tests/ps2-render.mjs <out folder> <stage folder> ...'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

function png(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Texture source for Scene (lookup) and the rasteriser (image), like Library. */
function textures(dir) {
  const pool = new TexturePool();
  for (const f of fs.readdirSync(dir)) {
    const m = /^([0-9a-f]{6})\.tri$/i.exec(f);
    if (m) try { pool.addTri(new Uint8Array(fs.readFileSync(path.join(dir, f))), parseInt(m[1], 16)); } catch (e) { /* not a TRI */ }
  }
  const images = new Map();
  return {
    pool,
    lookup(h) {
      const i = pool.infos.get(h);
      return i ? { w: i.w, h: i.h, ox: i.ox, oy: i.oy, iw: i.img.w, ih: i.img.h, u0: i.u0, v0: i.v0, uw: i.uw, vh: i.vh } : null;
    },
    image(h) {
      const i = pool.infos.get(h);
      if (!i) return null;
      const k = i.tri + '|' + i.imgOff;
      if (!images.has(k)) { const r = pool.raw(h); images.set(k, r ? { w: r.w, h: r.h, rgba: r.data } : null); }
      return images.get(k);
    },
  };
}

function rasterise(prims, view, scale, tx) {
  const W = Math.max(1, Math.round(view.w * scale)), H = Math.max(1, Math.round(view.h * scale));
  const fb = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { fb[4 * i] = 0.12; fb[4 * i + 1] = 0.12; fb[4 * i + 2] = 0.14; fb[4 * i + 3] = 1; }
  const tri = (a, b, c, img, blend) => {
    const P = [a, b, c].map(v => [(v.x - view.x) * scale, (v.y - view.y) * scale]);
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (!area) return;
    const x0 = Math.max(0, Math.floor(Math.min(...P.map(p => p[0])))), x1 = Math.min(W - 1, Math.ceil(Math.max(...P.map(p => p[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...P.map(p => p[1])))), y1 = Math.min(H - 1, Math.ceil(Math.max(...P.map(p => p[1]))));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area;
      const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const col = [0, 1, 2, 3].map(k => a.c[k] * w0 + b.c[k] * w1 + c.c[k] * w2);
      if (img) {
        const u = a.u * w0 + b.u * w1 + c.u * w2, v = a.v * w0 + b.v * w1 + c.v * w2;
        const tx_ = Math.min(img.w - 1, Math.max(0, Math.floor(u))), ty = Math.min(img.h - 1, Math.max(0, Math.floor(v)));
        const o = (ty * img.w + tx_) * 4;
        for (let k = 0; k < 4; k++) col[k] *= img.rgba[o + k] / 255;
      }
      const o = (y * W + x) * 4, sa = col[3];
      for (let k = 0; k < 3; k++) {
        const s = col[k], d = fb[o + k];
        fb[o + k] = blend === 'add' ? d + s * sa : blend === 'sub' ? d - s * sa : blend === 'none' ? s : s * sa + d * (1 - sa);
      }
    }
  };
  for (const p of prims) {
    const img = p.tex !== null && p.tex !== undefined && p.uv ? tx.image(p.tex) : null;
    if (p.kind === 'lines') {
      const w = 0.5 / scale;
      for (let k = 0; k + 1 < p.pts.length; k++) {
        const [ax, ay] = p.pts[k], [bx, by] = p.pts[k + 1];
        const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, nx = -dy / l * w, ny = dx / l * w;
        const q = [[ax + nx, ay + ny, p.cols[k]], [bx + nx, by + ny, p.cols[k + 1]], [bx - nx, by - ny, p.cols[k + 1]], [ax - nx, ay - ny, p.cols[k]]]
          .map(([x, y, c]) => ({ x, y, c, u: 0, v: 0 }));
        tri(q[0], q[1], q[2], null, p.blend); tri(q[0], q[2], q[3], null, p.blend);
      }
      continue;
    }
    if (p.pts.length < 3) continue;
    const V = p.pts.map(([x, y], k) => ({ x, y, c: p.cols[k], u: img && p.uv[k] ? p.uv[k][0] : 0, v: img && p.uv[k] ? p.uv[k][1] : 0 }));
    for (let i = 1; i + 1 < V.length; i++) tri(V[0], V[i], V[i + 1], img, p.blend);
  }
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H * 4; i++) rgba[i] = (i & 3) === 3 ? 255 : Math.max(0, Math.min(255, Math.round(fb[i] * 255)));
  return { w: W, h: H, rgba };
}

/** Frames side by side, scaled to a common height. */
function sheet(frames) {
  const H = Math.max(...frames.map(f => f.h)), W = frames.reduce((s, f) => s + f.w + 4, 0);
  const rgba = new Uint8Array(W * H * 4).fill(255);
  let x0 = 0;
  for (const f of frames) {
    for (let y = 0; y < f.h; y++) rgba.set(f.rgba.subarray(y * f.w * 4, (y + 1) * f.w * 4), (y * W + x0) * 4);
    x0 += f.w + 4;
  }
  return { w: W, h: H, rgba };
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
        missingTex += la.texKeys.filter(k => !tx.lookup(k)).length;
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
