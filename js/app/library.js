// The user's game files, read in the browser: a picked folder (File System Access API or a folder <input>),
// listing of LA2 files (loose and inside .dar archives), MGO2 decryption, and texture lookup.
// Nothing is uploaded anywhere; files are read on demand.
import { readDar, readQar, inflateDlz } from '../formats/archives.js';
import { decrypt, checksumOk, keyForPath, discEncryption } from '../formats/mgo2crypt.js';
import { TexturePool, decodeDxt, parseTxn } from '../formats/textures.js';

const dirname = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const basename = p => p.slice(p.lastIndexOf('/') + 1);
const ext = p => (p.match(/\.[^./]+$/) || [''])[0].toLowerCase();

// ---- virtual file systems ---------------------------------------------------------------------------------------
/** Files from <input type=file webkitdirectory>: paths relative to the picked folder's parent. */
export class FileListFS {
  constructor(fileList) {
    this.files = new Map();
    for (const f of fileList) {
      const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      this.files.set(p, f);
    }
    const first = [...this.files.keys()][0] || '';
    this.name = first.split('/')[0] || 'files';
  }
  async list() { return [...this.files].map(([path, f]) => ({ path, size: f.size })); }
  async read(path) { const f = this.files.get(path); if (!f) throw new Error('no such file: ' + path); return new Uint8Array(await f.arrayBuffer()); }
}

/** A FileSystemDirectoryHandle (Chromium's showDirectoryPicker): scanned recursively once. */
export class HandleFS {
  constructor(handle) { this.root = handle; this.name = handle.name; this.handles = null; }
  async list(progress) {
    if (!this.handles) {
      this.handles = new Map();
      const walk = async (dir, prefix) => {
        for await (const [name, h] of dir.entries()) {
          const p = prefix + '/' + name;
          if (h.kind === 'directory') await walk(h, p);
          else { this.handles.set(p, h); if (progress && this.handles.size % 200 === 0) progress(this.handles.size); }
        }
      };
      await walk(this.root, this.root.name);
    }
    const out = [];
    for (const [path, h] of this.handles) out.push({ path, size: null, handle: h });
    return out;
  }
  async read(path) { const h = this.handles.get(path); if (!h) throw new Error('no such file: ' + path); return new Uint8Array(await (await h.getFile()).arrayBuffer()); }
}

/** Development / automated tests: a folder served over HTTP with a JSON listing (see tests/serve.py). */
export class HttpFS {
  constructor(base) { this.base = base.replace(/\/$/, ''); this.name = 'http'; }
  async list() {
    const l = await (await fetch(this.base + '/__list.json')).json();
    this.name = l.name;
    return l.files.map(([path, size]) => ({ path, size }));
  }
  async read(path) {
    const r = await fetch(this.base + '/' + path.split('/').slice(1).map(encodeURIComponent).join('/'));
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
    return new Uint8Array(await r.arrayBuffer());
  }
}

// ---- library ------------------------------------------------------------------------------------------------
const TEX_EXT = new Set(['.qar', '.txn', '.dlz']);
const BUDGET_POOLS = 512 << 20, BUDGET_IMAGES = 384 << 20;

export class Library {
  constructor(fs, settings = {}) {
    this.fs = fs;
    this.settings = settings;          // {key: 'stage/<name>' override}
    this.files = [];                   // all paths
    this.dirs = new Map();             // dir -> {files: [paths], subdirs: Set}
    this.raw = new Map();              // path -> decrypted bytes (LRU-ish, small files and archives in use)
    this.encrypted = new Map();        // path -> key it was decrypted with (saves are re-encrypted with it)
    this.keys = new Map();             // dir -> detected key
    this.pools = new Map();            // location "dir|base" -> TexturePool (LRU by insertion)
    this.images = new Map();           // "dir|base|hash" -> {w, h, rgba}
    this.index = null;                 // texture hash -> [locations] for the current folder
    this.fallback = null;
  }

  async scan(progress) {
    const list = await this.fs.list(progress);
    this.files = list.map(f => f.path).sort();
    this.sizes = new Map(list.map(f => [f.path, f.size]));
    this.dirs = new Map();
    const dir = d => { if (!this.dirs.has(d)) this.dirs.set(d, { files: [], subdirs: new Set() }); return this.dirs.get(d); };
    for (const p of this.files) {
      const d = dirname(p);
      dir(d).files.push(p);
      let c = d;
      while (c.includes('/')) { const parent = dirname(c); dir(parent).subdirs.add(c); c = parent; }
    }
    return this.files.length;
  }

  /** Folders that hold LA2 data (loose .la2 or .dar), for the folder tree. */
  interesting(d) {
    const e = this.dirs.get(d);
    return e ? e.files.filter(p => ['.la2', '.dar', '.qar', '.dlz', '.txn'].includes(ext(p))).length : 0;
  }

  // ---- decryption ------------------------------------------------------------------------------------------
  /** Read a file, decrypting MGO2 stage files (key from the path, the settings, or detection in its folder).
   *  Inside a known disc / PSN title folder the disc ID decides: USRDIR/o is always encrypted, USRDIR/mgs only on
   *  the PSN releases (see discEncryption); elsewhere encryption is detected from the file's checksum. */
  async read(path) {
    if (this.raw.has(path)) return this.raw.get(path);
    let data = await this.fs.read(path);
    const disc = discEncryption(path);
    const key = disc && !disc.encrypted ? null : this.settings.key || keyForPath(path) || this.keys.get(dirname(path));
    if (disc && !disc.encrypted) { /* plain Blu-ray MGS4 data */ }
    else if (key && data.length >= 0x18 && checksumOk(data, key)) { data = decrypt(data, key); this.encrypted.set(path, key); }
    else if (!key && data.length >= 0x18 && (disc || ['.dar', '.qar', '.dlz', '.txn', '.la2'].includes(ext(path)))) {
      const k = await this.detectKey(dirname(path), data);
      if (k) { data = decrypt(data, k); this.encrypted.set(path, k); }
    }
    // an already-decrypted copy inside an encrypted disc area is still encrypted when saved
    if (disc && disc.encrypted && key && !this.encrypted.has(path)) this.encrypted.set(path, key);
    if (data.length < (32 << 20)) {
      this.raw.set(path, data);
      let total = 0;
      for (const v of this.raw.values()) total += v.length;
      for (const k of this.raw.keys()) { if (total <= (160 << 20) || k === path) break; total -= this.raw.get(k).length; this.raw.delete(k); }
    }
    return data;
  }
  /** "stage/<name>" key for files outside the stage/<name> layout: tries every folder name on the path. */
  async detectKey(dir, sample) {
    if (this.keys.has(dir)) return this.keys.get(dir);
    let found = null;
    const names = new Set(dir.split('/'));
    for (const d of this.dirs.keys()) { const parts = d.split('/'); const i = parts.lastIndexOf('stage'); if (i >= 0 && parts[i + 1]) names.add(parts[i + 1]); }
    for (const n of names) if (n && checksumOk(sample, 'stage/' + n)) { found = 'stage/' + n; break; }
    this.keys.set(dir, found);
    return found;
  }
  keyFor(dir) { const d = discEncryption(dir + '/x'); if (d && !d.encrypted) return null; return this.settings.key || keyForPath(dir + '/x') || this.keys.get(dir) || null; }

  // ---- LA2 files ---------------------------------------------------------------------------------------------
  /** LA2 files of a folder: loose ones and those inside its .dar archives ({id, path, entry}). */
  async la2Files(dir, recursive = false, progress) {
    const inDir = p => recursive ? p.startsWith(dir + '/') || dirname(p) === dir : dirname(p) === dir;
    const paths = this.files.filter(inDir);
    const out = [];
    for (const p of paths) if (ext(p) === '.la2') out.push({ id: p.slice(dir.length + 1), path: p, entry: null });
    const dars = paths.filter(p => ext(p) === '.dar');
    for (let i = 0; i < dars.length; i++) {
      if (progress) progress(i, dars.length, dars[i]);
      try {
        const d = readDar(await this.read(dars[i]));
        for (const e of d.entries) if (e.name.toLowerCase().endsWith('.la2'))
          out.push({ id: dars[i].slice(dir.length + 1) + '::' + e.name, path: dars[i], entry: e.name });
      } catch (e) { /* not a DAR this tool understands */ }
    }
    return out;
  }
  /** The paired o/stage/<name> <-> o/dl/p/stage/<name> folder of a folder, or null. */
  pairedDir(d) {
    const parts = d.split('/'), i = parts.lastIndexOf('stage');
    if (i < 0) return null;
    const other = parts.slice(i - 2, i).join('/') === 'dl/p'
      ? [...parts.slice(0, i - 2), ...parts.slice(i)].join('/') : [...parts.slice(0, i), 'dl', 'p', ...parts.slice(i)].join('/');
    return this.dirs.has(other) ? other : null;
  }
  /** Find an LA2 by file name near a folder, the way the game resolves resident files: the dl/p patch folder
   *  first, newer resident_NNNNNN.dar archives before older ones, then the stage folder and the folders above. */
  async findLa2(name, dir) {
    const want = name.toLowerCase();
    this.la2Names = this.la2Names || new Map();         // .dar path -> Map(lower-case entry name -> entry name)
    const dirs = [];
    const add = d => { if (d && this.dirs.has(d) && !dirs.includes(d)) dirs.push(d); };
    for (let d = dir, k = 0; d && k < 5; k++) {
      add(this.pairedDir(d)); add(d);
      if (basename(dirname(d)) === 'stage' || !d.includes('/')) break;
      d = dirname(d);
    }
    dirs.sort((a, b) => b.includes('/dl/p/') - a.includes('/dl/p/'));
    const rank = p => { const m = /_(\d+)\.dar$/i.exec(p); return m ? +m[1] : basename(p).toLowerCase() === 'resident.dar' ? 0 : -1; };
    for (const d of dirs) {
      const files = this.dirs.get(d).files;
      const loose = files.find(p => basename(p).toLowerCase() === want);
      if (loose) return { id: loose, path: loose, entry: null };
      for (const p of files.filter(p => ext(p) === '.dar').sort((a, b) => rank(b) - rank(a))) {
        let names = this.la2Names.get(p);
        if (!names) {
          names = new Map();
          try { for (const e of readDar(await this.read(p)).entries) names.set(e.name.toLowerCase(), e.name); } catch (e) { /* not a DAR */ }
          this.la2Names.set(p, names);
        }
        const e = names.get(want);
        if (e) return { id: p + '::' + e, path: p, entry: e };
      }
    }
    return null;
  }
  async la2Bytes(f) {
    const data = await this.read(f.path);
    if (!f.entry) return data;
    const d = readDar(data), e = d.entries.find(x => x.name === f.entry);
    if (!e) throw new Error('entry not found: ' + f.entry);
    return data.slice(e.offset, e.offset + e.size);
  }

  // ---- textures ----------------------------------------------------------------------------------------------
  /** Texture sources for an LA2 folder: its own .qar/.txn, then ancestors up to the stage folder;
   *  plus the paired o/stage/<name> <-> o/dl/p/stage/<name> folder. */
  textureDirs(dir) {
    const has = d => (this.dirs.get(d)?.files || []).some(p => ext(p) === '.qar' || ext(p) === '.txn');
    // a folder and its extracted Qar/ subfolder (the TXNs of an extracted archive, beside its Dar/)
    const sources = d => [d, ...[...(this.dirs.get(d)?.subdirs || [])].filter(s => basename(s).toLowerCase() === 'qar')].filter(has);
    const found = sources(dir);
    let d = dir;
    for (let k = 0; k < 4 && d.includes('/'); k++) {
      d = dirname(d);
      found.push(...sources(d));
      if (basename(dirname(d)) === 'stage') break;
    }
    const paired = [];
    for (const d of found) {
      const parts = d.split('/'), i = parts.lastIndexOf('stage');
      if (i < 0) continue;
      const other = parts.slice(i - 2, i).join('/') === 'dl/p'
        ? [...parts.slice(0, i - 2), ...parts.slice(i)].join('/') : [...parts.slice(0, i), 'dl', 'p', ...parts.slice(i)].join('/');
      if (this.dirs.has(other) && has(other)) paired.push(other);
    }
    return [...found, ...paired];
  }
  /** Index the TXN tables of the given folders: hash -> [location "dir|base"]. */
  async indexTextures(dirs, progress) {
    const index = new Map();
    const archives = dirs.flatMap(d => (this.dirs.get(d)?.files || []).filter(p => ext(p) === '.qar' || ext(p) === '.txn'));
    for (let i = 0; i < archives.length; i++) {
      const p = archives[i];
      if (progress) progress(i, archives.length, p);
      try {
        const data = await this.read(p);
        const extracted = ext(p) === '.txn' && basename(dirname(p)).toLowerCase() === 'qar';
        const loc = dirname(p) + '|' + (extracted ? '@txn' : basename(p).slice(0, -4));
        const tables = ext(p) === '.txn' ? [data] : readQar(data).filter(e => e.name.endsWith('.txn')).map(e => e.data);
        for (const t of tables) for (const info of parseTxn(t)) {
          if (!index.has(info.tex)) index.set(info.tex, []);
          if (!index.get(info.tex).includes(loc)) index.get(info.tex).push(loc);
        }
      } catch (e) { /* unreadable archive */ }
    }
    return index;
  }
  async openTextures(dir, progress) {
    this.texDirs = this.textureDirs(dir);
    this.index = await this.indexTextures(this.texDirs, progress);
    this.fallback = null;
  }
  async searchAll(progress) {
    const dirs = [...this.dirs.keys()].filter(d => (this.dirs.get(d).files || []).some(p => ext(p) === '.qar' || ext(p) === '.txn'));
    this.fallback = await this.indexTextures(dirs, progress);
  }
  /** DLZ files holding a location's texture data: <base>*.dlz, or every DLZ beside a loose <hash>.txn; an
   *  extracted Qar folder's TXNs ("@txn") use the DLZs beside them, else those of the folder above. */
  dlzFor(loc) {
    const [dir, base] = loc.split('|');
    const files = this.dirs.get(dir)?.files || [];
    const dlzIn = list => list.filter(p => ext(p) === '.dlz');
    if (base === '@txn') return dlzIn(files).length ? dlzIn(files) : dlzIn(this.dirs.get(dirname(dir))?.files || []);
    let dlz = files.filter(p => ext(p) === '.dlz' && basename(p).startsWith(base) && '._'.includes(basename(p)[base.length]));
    if (!dlz.length && !files.some(p => basename(p) === base + '.qar') && files.some(p => basename(p) === base + '.txn'))
      dlz = files.filter(p => ext(p) === '.dlz');
    return dlz;
  }
  async pool(loc, overrides = new Map()) {
    if (this.pools.has(loc)) { const p = this.pools.get(loc); this.pools.delete(loc); this.pools.set(loc, p); return p; }
    const [dir, base] = loc.split('|');
    const pool = new TexturePool();
    const files = this.dirs.get(dir)?.files || [];
    const qar = files.find(p => basename(p) === base + '.qar'), txn = files.find(p => basename(p) === base + '.txn');
    if (base === '@txn') {
      // the extracted TXNs share one pool, so their common DLZs are inflated once
      for (const p of files.filter(p => ext(p) === '.txn')) try { pool.addTxn(await this.read(p)); } catch (x) {}
    }
    else if (qar) for (const e of readQar(await this.read(qar))) { if (e.name.endsWith('.txn')) try { pool.addTxn(e.data); } catch (x) {} }
    else if (txn) pool.addTxn(await this.read(txn));
    // MGO2 DLC folders (o/dl/p/stage/<name>): .dci image remaps, and the base folder's DLZs underneath, since a
    // patched TXN keeps reading its unchanged images from the base stage
    for (const p of files.filter(p => ext(p) === '.dci' && basename(p).startsWith(base))) {
      try { pool.addDci(await this.read(p)); } catch (x) { /* not a DCI */ }
    }
    const under = dir.includes('/dl/p/') && this.pairedDir(dir) ? this.dlzFor(this.pairedDir(dir) + '|' + base) : [];
    pool.bytes = 0;
    for (const p of [...under, ...this.dlzFor(loc)]) {
      const dld = overrides.get(p) || inflateDlz(await this.read(p));
      pool.addDld(dld);
      pool.bytes += dld.length;
    }
    this.pools.set(loc, pool);
    let total = 0;
    for (const p of this.pools.values()) total += p.bytes;
    for (const [k, p] of this.pools) {
      if (total <= BUDGET_POOLS || k === loc) break;
      total -= p.bytes; this.pools.delete(k);
      for (const ik of [...this.images.keys()]) if (ik.startsWith(k + '|')) this.images.delete(ik);
    }
    return pool;
  }
  /** Locations of a texture: the folder's own first, then the wide search. */
  locations(h) {
    return [...(this.index?.get(h) || []), ...((this.fallback?.get(h) || []).filter(l => !(this.index?.get(h) || []).includes(l)))];
  }
  /** Load everything needed for these texture hashes (async); afterwards lookup() / image() answer synchronously. */
  async prepare(hashes, overrides) {
    this.resolved = this.resolved || new Map();
    for (const h of hashes) {
      if (this.resolved.has(h)) continue;
      let hit = null, first = null;
      for (const loc of this.locations(h)) {
        const pool = await this.pool(loc, overrides);
        const info = pool.infos.get(h);
        first = first || info;
        if (info && pool.raw(h)) { hit = { loc, info, pool }; break; }
      }
      this.resolved.set(h, hit);
    }
  }
  resetResolved() { this.resolved = new Map(); this.images.clear(); }
  /** {w, h, ox, oy, iw, ih} (texture region within its image) or null if not found. */
  lookup(h) {
    const r = this.resolved?.get(h);
    if (!r) return null;
    return { w: r.info.w, h: r.info.h, ox: r.info.ox, oy: r.info.oy, iw: r.info.img.w, ih: r.info.img.h, loc: r.loc };
  }
  /** Decoded RGBA of the image a texture lives in (shared by atlas regions). */
  image(h) {
    const r = this.resolved?.get(h);
    if (!r) return null;
    const key = r.loc + '|' + r.info.tri + '|' + r.info.imgOff;
    if (this.images.has(key)) return this.images.get(key);
    const raw = r.pool.raw(h);
    if (!raw) return null;
    const img = { key, w: raw.w, h: raw.h, rgba: decodeDxt(raw.w, raw.h, raw.fourcc, raw.data) };
    this.images.set(key, img);
    let total = 0;
    for (const v of this.images.values()) total += v.rgba.length;
    for (const k of this.images.keys()) { if (total <= BUDGET_IMAGES || k === key) break; total -= this.images.get(k).rgba.length; this.images.delete(k); }
    return img;
  }
  imageKey(h) { const r = this.resolved?.get(h); return r ? r.loc + '|' + r.info.tri + '|' + r.info.imgOff : null; }
}

export { dirname, basename, ext };
