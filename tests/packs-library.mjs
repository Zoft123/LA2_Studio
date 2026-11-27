// Offline check of packed game data in the app's own library: opens a game folder through PackFS + Library exactly
// like the app (STAGE.DAT, SLOT.DAT, _zar, STAGEDAT.PDT, .psarc become folders), then for every folder with layouts
// lists them, indexes its textures, parses each layout and resolves its texture references.
//
//   node tests/packs-library.mjs <game folder> [--per-folder N] [--folders REGEX] [--render] [--search-all]
//
// Prints layouts / texture references resolved per container. Run it on an extracted copy too to compare.
import fs from 'node:fs';
import path from 'node:path';
import { Library } from '../js/app/library.js';
import { PackFS } from '../js/app/packfs.js';
import { LA2 } from '../js/formats/la2.js';
import { openLa3, isLa3 } from '../js/formats/la3.js';
import { Scene } from '../js/engine/scene.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const perFolder = +opt('--per-folder', 4), only = opt('--folders', null);
const render = args.includes('--render') && !!args.splice(args.indexOf('--render'), 1);
const searchAll = args.includes('--search-all') && !!args.splice(args.indexOf('--search-all'), 1);
const [root] = args;
if (!root) { console.error('usage: node tests/packs-library.mjs <game folder> [--per-folder N] [--folders REGEX] [--render]'); process.exit(2); }

/** The game folder as the app sees a picked folder: paths "<folder name>/…", whole-file and range reads. */
class NodeFS {
  constructor(dir) { this.dir = path.resolve(dir); this.name = path.basename(this.dir); this.fds = new Map(); }
  async list() {
    const out = [];
    const walk = d => {
      for (const name of fs.readdirSync(d).sort()) {
        const p = path.join(d, name), st = fs.statSync(p);          // follows links (test folders link game files)
        if (st.isDirectory()) walk(p); else out.push({ path: this.name + '/' + path.relative(this.dir, p).split(path.sep).join('/'), size: st.size });
      }
    };
    walk(this.dir);
    return out;
  }
  full(p) { return path.join(this.dir, ...p.split('/').slice(1)); }
  async read(p) { return new Uint8Array(fs.readFileSync(this.full(p))); }
  async readRange(p, offset, length) {
    if (!this.fds.has(p)) this.fds.set(p, fs.openSync(this.full(p), 'r'));
    const b = Buffer.alloc(length); const n = fs.readSync(this.fds.get(p), b, 0, length, offset);
    return new Uint8Array(b.buffer, b.byteOffset, n);
  }
  async size(p) { return fs.statSync(this.full(p)).size; }
}

const t0 = Date.now();
const fsys = new PackFS(new NodeFS(root));
const lib = new Library(fsys, {});
const n = await lib.scan();
console.log(`${n} files (${fsys.packs.size} packed files read in place) in ${Date.now() - t0} ms` +
  (fsys.failed.length ? '; failed: ' + fsys.failed.map(f => f.path + ' ' + f.error).join(', ') : ''));
for (const [p, pack] of fsys.packs) console.log(`  ${p}: ${pack.label}, ${pack.entries.length} files`);

if (searchAll) { await lib.searchAll(); console.log('searched everything: ' + lib.fallback.size + ' textures indexed'); }
const stats = new Map();          // container (or "loose") -> {layouts, parsed, refs, resolved}
const statFor = d => { const c = [...fsys.packs.keys()].find(p => d === p || d.startsWith(p + '/')) || '(not packed)'; if (!stats.has(c)) stats.set(c, { folders: 0, layouts: 0, parsed: 0, refs: 0, resolved: 0, failed: [] }); return stats.get(c); };
const dirs = [...lib.dirs.keys()].filter(d => lib.dirs.get(d).files.some(p => /\.(la2|la3|dar)$/i.test(p))).filter(d => !only || new RegExp(only).test(d)).sort();
for (const d of dirs) {
  const files = await lib.la2Files(d);
  if (!files.length) continue;
  const st = statFor(d); st.folders++;
  const fallback = lib.fallback;
  await lib.openTextures(d);
  lib.fallback = fallback;                 // "Search everything" (--search-all) stays on, as in the app
  lib.resetResolved();
  for (const f of files.slice(0, perFolder)) {
    st.layouts++;
    try {
      const bytes = await lib.la2Bytes(f);
      const la = isLa3(bytes) ? openLa3(bytes) : new LA2(bytes);
      if (lib.isPspLayout(la)) la.usePspTextures();
      await lib.prepare(la.texKeys, new Map());
      st.parsed++; st.refs += la.texKeys.length;
      st.resolved += la.texKeys.filter(k => lib.lookup(k) && lib.image(k)).length;
      if (render) new Scene(la, lib).primitives();
    } catch (e) { st.failed.push(f.id + ': ' + e.message); }
  }
}
for (const [c, s] of stats) {
  console.log(`${c}: ${s.folders} folders, ${s.parsed}/${s.layouts} layouts parsed, ${s.resolved}/${s.refs} texture references resolved`);
  for (const f of s.failed.slice(0, 5)) console.log('   FAIL', f);
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
