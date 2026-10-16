// Format round-trip tests against your own game files (no game data ships with this repository).
//
//   node tests/run.mjs <folder> [<folder> ...]
//
// For every .la2 found (loose, or inside .dar archives; MGO2 archives are decrypted) it checks that:
//   1. the file parses,
//   2. the writer rebuilds it byte for byte,
//   3. structural edits (duplicate, delete, add objects) produce a file that parses with consistent layer counts,
//   4. the playback engine can build the initial state and play the first action to its end.
import fs from 'fs';
import path from 'path';
import { readDar } from '../js/formats/archives.js';
import { decrypt, checksumOk, keyForPath } from '../js/formats/mgo2crypt.js';
import { LA2 } from '../js/formats/la2.js';
import { Model } from '../js/formats/model.js';
import { Scene, Timeline } from '../js/engine/scene.js';

const roots = process.argv.slice(2);
if (!roots.length) { console.error('usage: node tests/run.mjs <folder> [<folder> ...]'); process.exit(2); }
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let failed = 0;
for (const root of roots) {
  const stats = { files: 0, exact: 0, edits: 0, played: 0 }, problems = [];
  const t0 = Date.now();
  for (const f of walk(root)) {
    let items = [];
    if (f.toLowerCase().endsWith('.la2')) items = [[f, new Uint8Array(fs.readFileSync(f))]];
    else if (f.toLowerCase().endsWith('.dar')) {
      let d = new Uint8Array(fs.readFileSync(f));
      const k = keyForPath(f.split(path.sep).join('/'));
      if (k && checksumOk(d, k)) d = decrypt(d, k);
      try { items = readDar(d).entries.filter(e => e.name.toLowerCase().endsWith('.la2')).map(e => [f + '::' + e.name, d.subarray(e.offset, e.offset + e.size)]); }
      catch (e) { continue; }
    }
    for (const [id, data] of items) {
      stats.files++;
      try {
        const la = new LA2(data);
        if (same(new Model(data).build(), data)) stats.exact++; else problems.push(['not byte-exact', id]);
        const m = new Model(data);
        if (m.objects.length > 3) {
          m.duplicate(2, 16, 0); m.delete(1); m.addObject(6, { x: 160, y: 160 }); m.addObject(10, { text: 'TEST' });
          const e = new LA2(m.build());
          const lc = e.layers.reduce((a, l) => a + l[2], 0);
          if (e.layers.length && lc !== e.objects.length) throw new Error(`layer counts ${lc} vs ${e.objects.length} objects`);
          stats.edits++;
        }
        const sc = new Scene(la, null);
        sc.primitives();
        if (la.actions.length) {
          const tl = new Timeline(la, 0);
          sc.setTimeline(tl);
          sc.seek(Math.min(tl.length(), 2000));
          sc.primitives();
        }
        stats.played++;
      } catch (e) { problems.push([String(e.message || e).slice(0, 120), id]); }
    }
  }
  const ok = stats.exact === stats.files && stats.played === stats.files && !problems.length;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${root}: ${stats.files} LA2 files, ${stats.exact} byte-exact, ${stats.edits} edited, ${stats.played} played (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const [what, id] of problems.slice(0, 10)) console.log('   ', what, '-', id);
}
process.exit(failed ? 1 : 0);
