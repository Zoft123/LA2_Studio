// A file system that also shows the inside of packed game data: STAGE.DAT / SLOT.DAT (MGS3, MGO1, Portable Ops),
// Portable Ops _zar stage archives, Peace Walker's STAGEDAT.PDT and SLOT.DAT (+ SLOT.KEY), and MGS3 HD .psarc
// archives. Each container becomes a folder of the same name holding its files ("…/STAGE_2.DAT/m001a/1a2b3c.la2"),
// so the rest of the app reads them like extracted folders. Containers are read in place, in ranges; nothing is
// extracted to disk.
import { packKind, openPack } from '../formats/packs.js';

const basename = p => p.slice(p.lastIndexOf('/') + 1);
const dirname = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';

export class PackFS {
  /** @param base a FileListFS / HandleFS / HttpFS (read(path), optionally readRange(path, offset, length), size(path)) */
  constructor(base) {
    this.base = base;
    this.name = base.name;
    this.packs = new Map();          // container path -> pack
    this.virtual = new Map();        // path inside a container -> {container, rel, entry}
    this.recent = [];                // containers read most recently (their caches are kept)
    this.failed = [];                // containers that could not be opened: [{path, error}]
  }

  async list(progress) {
    const list = await this.base.list(progress);
    const lower = new Map(list.map(f => [f.path.toLowerCase(), f.path]));
    const out = [...list];
    const containers = list.filter(f => packKind(basename(f.path)));
    for (let i = 0; i < containers.length; i++) {
      const f = containers[i], kind = packKind(basename(f.path));
      if (progress) progress(out.length, `opening ${basename(f.path)} (${i + 1}/${containers.length})`);
      try {
        const size = f.size ?? await this.size(f.path);
        const src = { size, read: (offset, length) => this.readRange(f.path, offset, length, size) };
        const sibling = async name => {
          const p = lower.get((dirname(f.path) + '/' + name).toLowerCase());
          return p ? this.base.read(p) : null;
        };
        const pack = await openPack(kind, src, sibling);
        if (!pack) continue;
        this.packs.set(f.path, pack);
        for (const e of pack.entries) {
          const p = f.path + '/' + e.path;
          this.virtual.set(p, { container: f.path, rel: e.path, entry: e });
          out.push({ path: p, size: e.size });
        }
      } catch (e) { this.failed.push({ path: f.path, error: e.message }); }
    }
    return out;
  }

  async read(path) {
    const v = this.virtual.get(path);
    if (!v) return this.base.read(path);
    const pack = this.packs.get(v.container);
    // keep the decompressed data of the few containers in use; let the others go
    this.recent = [v.container, ...this.recent.filter(c => c !== v.container)];
    for (const c of this.recent.splice(4)) this.packs.get(c)?.forget?.();
    return pack.read(v.rel);
  }

  async size(path) {
    if (this.base.size) return this.base.size(path);
    return (await this.base.read(path)).length;
  }
  /** Bytes [offset, offset + length) of a real file (clamped to its end). */
  async readRange(path, offset, length, size) {
    const end = Math.min(offset + length, size ?? Infinity);
    if (end <= offset) return new Uint8Array(0);
    if (this.base.readRange) return this.base.readRange(path, offset, end - offset);
    // no range reads: read the file once and keep it while it is being listed / read
    if (this._whole?.path !== path) this._whole = { path, data: await this.base.read(path) };
    return this._whole.data.subarray(offset, end);
  }

  /** Is this path inside a container? */
  isVirtual(path) { return this.virtual.has(path); }
  /** The container a path is inside: {path, kind, label, rel} or null. */
  container(path) {
    const v = this.virtual.get(path);
    if (!v) return null;
    const pack = this.packs.get(v.container);
    return { path: v.container, kind: pack.kind, label: pack.label, rel: v.rel };
  }
  /** Name hash of a file stored by hash only (it is named <hash>.<ext>), or null. */
  nameHash(path) { return this.virtual.get(path)?.entry.hash ?? null; }
  /** A container rebuilt with some of its files replaced ({rel: bytes}), for containers that support it (_zar). */
  rebuild(containerPath, replace) {
    const pack = this.packs.get(containerPath);
    return pack?.rebuild ? pack.rebuild(replace) : null;
  }
}
