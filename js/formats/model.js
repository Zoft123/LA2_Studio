// Mutable LA2 model and writer: structural edits (packets, strings, keys, objects) with every size and offset
// regenerated. A stock file rebuilds byte for byte (checked on MGA, MGO2 and MGS4 layouts).
//
// MGS4 layouts reach millions of status blocks and keys, so nothing is decoded up front: blocks stay byte ranges of
// the source until edited, tracks stay raw key bytes until edited, and key targets are remapped in one pass on build.
// Blocks are identified by id (>= 0: index in the source file, < 0: new block); the position order is `order`.
import { Reader, Writer, latin1, pack, strcode, concat } from '../core/bin.js';

const SLOTS = ['obj_def', 'status', 'action', 'action_table', 'tri', 'unused', 'tex_tbl', 'color_tbl', 'uv_tbl',
  'ctrl_vertex_tbl', 'font', 'layer'];
const RAW = ['tex_tbl', 'color_tbl', 'uv_tbl', 'ctrl_vertex_tbl', 'font', 'layer'];
const EMPTY = new Uint8Array(0);

// Typical type flag bits per object type in stock files (low nibble = type): 0x10000 matrix (Nul/Ctrl), 0x20000
// width/height, 0x40000 textured, 0x80000 string, 0x1000000 / 0x2000000 alpha-register / matrix + base-colour slots.
const NEW_FLAGS = { 0: 0x3010000, 1: 0x3010000, 2: 0x3020000, 3: 0x3060000, 4: 0x3040000, 5: 0x3000000, 6: 0x3000000,
  7: 0x3000000, 8: 0x3000000, 9: 0x3000000, 10: 0x30e0000, 11: 0x31e0000 };

export class Model {
  /** @param {Uint8Array} data */
  constructor(data) {
    const be = new Reader(data, false).u32(0);
    const le = this.le = !(be === 0x10008 || be === 0x10009);
    const r = this.r = new Reader(data, le);
    this.src = data;
    this.version = r.u32(0);
    const o = this.offsets = {};
    SLOTS.forEach((n, i) => { o[n] = r.u32(4 + 4 * i); });
    const ntri = o.tri ? r.u32(o.tri) : 0;
    this.tri = [];
    for (let i = 0; i < ntri; i++) this.tri.push(r.u32(o.tri + 4 + 4 * i));
    this.triLate = !!o.tri && o.tri > (o.action_table || 0);      // MGS4 slot files: after the action table
    // objects (few: decoded)
    let p = o.obj_def;
    this.objHeader = data.slice(p, p + 44);
    const num = r.u16(p);
    p += 44;
    this.objects = [];
    for (let i = 0; i < num; i++) {
      const nx = r.u16(p + 16);
      this.objects.push(data.slice(p, p + 20 + 4 * nx));
      p += 20 + 4 * nx;
    }
    // status blocks: index only
    p = o.status;
    const nst = p ? r.u32(p) : 0;
    p += 4;
    this.origOff = new Uint32Array(nst);
    this.origSize = new Uint32Array(nst);
    for (let i = 0; i < nst; i++) {
      const size = r.u16(p + 2);
      this.origOff[i] = p; this.origSize[i] = size;
      p += size;
    }
    this.order = new Int32Array(nst).map((_, i) => i);
    this.edited = new Map();          // id -> {count, packets, trailer}
    this.newBlocks = [];              // block id -(k + 1)
    // actions: tracks as raw key bytes
    p = o.action;
    const nact = p ? r.u32(p) : 0;
    p += 4;
    this.actions = [];
    for (let i = 0; i < nact; i++) {
      const ntr = r.u16(p), flags = r.u16(p + 2), size = r.u16(p + 4), b = r.u16(p + 6);
      const act = { flags, b, offset: p, tracks: [] };
      let t = p + 8;
      for (let k = 0; k < ntr; k++) {
        const tsize = r.u32(t + 4);
        act.tracks.push({ object: r.u16(t), nkeys: r.u16(t + 2), raw: tsize ? data.subarray(t + 8, t + tsize) : EMPTY, keys: null });
        t += tsize || 8;
      }
      // usSize: 16-bit, never read by libla; stale in some files, meaningless past 64 KB. Kept while unchanged.
      const end = size && p + size >= t ? p + size : t;
      act.sizeRaw = size; act.lenOrig = t - p;
      act.tail = size ? data.subarray(t, end) : EMPTY;
      this.actions.push(act);
      p = size ? end : p + 8;
    }
    p = o.action_table;
    const ntab = p ? r.u32(p) : 0;
    const byOff = new Map(this.actions.map((a, i) => [a.offset, i]));
    this.actionTable = [];
    for (let i = 0; i < ntab; i++) {
      const h = r.u32(p + 4 + 8 * i), off = r.u32(p + 8 + 8 * i);
      this.actionTable.push([h, byOff.has(off) ? byOff.get(off) : { raw: off }]);
    }
    // simple tables, kept raw (with any padding) up to the next section
    const ends = SLOTS.map(n => o[n]).filter(Boolean).sort((a, b) => a - b).concat([data.length]);
    const span = s => s ? data.slice(s, Math.min(...ends.filter(x => x > s))) : EMPTY;
    this.raw = {};
    for (const k of RAW) this.raw[k] = span(o[k]);
    [this.color_tbl, this.colorTail] = this._lists(this.raw.color_tbl);
    [this.uv_tbl, this.uvTail] = this._lists(this.raw.uv_tbl);
    const tr = this.raw.tex_tbl;
    if (tr.length) {
      const rr = new Reader(tr, le), n = rr.u32(0);
      this.tex_tbl = [];
      for (let i = 0; i < n; i++) this.tex_tbl.push([rr.u32(4 + 8 * i), rr.u32(8 + 8 * i)]);
      this.texTail = tr.slice(4 + 8 * n);
    } else { this.tex_tbl = null; this.texTail = EMPTY; }
    const lr = this.raw.layer;
    if (lr.length) {
      const rr = new Reader(lr, le), n = rr.u32(0);
      this.layers = [];
      for (let i = 0; i < n; i++) this.layers.push([rr.u32(4 + 8 * i), rr.u16(8 + 8 * i), rr.u16(10 + 8 * i)]);
      this.layerTail = lr.slice(4 + 8 * n);
    } else { this.layers = null; this.layerTail = EMPTY; }
  }

  /** Colour / UV lists: u32 count; {u16 n, u16 size, n x 4 bytes}. [null, tail] if absent or irregular. */
  _lists(raw) {
    if (!raw.length) return [null, EMPTY];
    const r = new Reader(raw, this.le), n = r.u32(0), out = [];
    let p = 4;
    for (let i = 0; i < n; i++) {
      const cnt = r.u16(p), size = r.u16(p + 2);
      if (size !== 4 + 4 * cnt) return [null, EMPTY];
      const l = [];
      for (let k = 0; k < cnt; k++) l.push(raw.slice(p + 4 + 4 * k, p + 8 + 4 * k));
      out.push(l);
      p += size;
    }
    return [out, raw.slice(p)];
  }
  _packLists(lists, tail) {
    const w = new Writer(this.le);
    w.u32(lists.length);
    for (const l of lists) { w.u16(l.length).u16(4 + 4 * l.length); for (const it of l) w.bytes(it); }
    w.bytes(tail);
    return w.result();
  }

  // ---- blocks -----------------------------------------------------------------------------------------------
  /** {u16 usPacketCount, packets [{type, data}], trailer} of block id (decoded from the source if needed). */
  block(id) {
    if (id < 0) return this.newBlocks[-id - 1];
    if (this.edited.has(id)) return this.edited.get(id);
    const r = this.r, start = this.origOff[id], size = this.origSize[id];
    const packets = [];
    let q = start + 4, end = q;
    while (q < start + size) {
      const t = r.u16(q), s = r.u16(q + 2);
      packets.push({ type: t, data: this.src.slice(q + 4, q + Math.max(4, s)) });
      end = q + Math.max(4, s);
      if (t === 0 || s === 0) break;
      q += s;
    }
    return { count: r.u16(start), packets, trailer: this.src.slice(end, start + size) };
  }
  _putBlock(id, b) { if (id < 0) this.newBlocks[-id - 1] = b; else this.edited.set(id, b); }
  _newBlock(b) { this.newBlocks.push(b); return -this.newBlocks.length; }
  _insertBlocks(pos, ids) {
    const o = new Int32Array(this.order.length + ids.length);
    o.set(this.order.subarray(0, pos)); o.set(ids, pos); o.set(this.order.subarray(pos), pos + ids.length);
    this.order = o;
  }
  blockAtPos(pos) { return this.block(this.order[pos]); }

  // ---- keys -------------------------------------------------------------------------------------------------
  /** Source block id and offset into it of a set / morph target file offset (null if it points nowhere). */
  _resolve(off) {
    const a = this.origOff;
    let lo = 0, hi = a.length - 1;
    if (hi < 0 || off < a[0]) return null;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid] <= off) lo = mid; else hi = mid - 1; }
    return off < a[lo] + this.origSize[lo] ? { id: lo, delta: off - a[lo] } : null;
  }
  /** Decoded keys [{type, data, ref: {id, delta} | null}] of a track (materialized for editing). */
  trackKeys(tr) {
    if (tr.keys) return tr.keys;
    const r = new Reader(tr.raw, this.le), out = [];
    let q = 0;
    for (let j = 0; j < tr.nkeys && q + 4 <= tr.raw.length; j++) {
      const kt = r.u16(q), ks = r.u16(q + 2);
      const k = { type: kt, data: tr.raw.slice(q + 4, q + Math.max(4, ks)), ref: null };
      if ((kt === 7 || kt === 8) && k.data.length >= (kt === 7 ? 4 : 8)) k.ref = this._resolve(new Reader(k.data, this.le).u32(kt === 7 ? 0 : 4));
      out.push(k);
      if (ks === 0) break;
      q += ks;
    }
    tr.keys = out;
    // keys parsed up to the end key; what follows inside the track is kept
    let consumed = 0;
    for (const k of out) consumed += 4 + k.data.length;
    tr.tail = tr.raw.slice(consumed);
    return out;
  }
  /** Every (source block id) a track's set / morph keys point at, without materializing it. */
  *_refIds(tr) {
    if (tr.keys) { for (const k of tr.keys) if (k.ref) yield k.ref.id; return; }
    const r = new Reader(tr.raw, this.le);
    let q = 0;
    for (let j = 0; j < tr.nkeys && q + 4 <= tr.raw.length; j++) {
      const kt = r.u16(q), ks = r.u16(q + 2);
      if ((kt === 7 && ks >= 8) || (kt === 8 && ks >= 12)) {
        const res = this._resolve(r.u32(q + (kt === 7 ? 4 : 8)));
        if (res) yield res.id;
      }
      if (ks === 0) break;
      q += ks;
    }
  }

  // ---- objects ----------------------------------------------------------------------------------------------
  // record {u32 strcode, u32 type, u16 id, u16 parent, u16 view-next id, u16 vertices, u16 units, u16 layer}
  obj(i) {
    const r = new Reader(this.objects[i], this.le);
    return { hash: r.u32(0), flags: r.u32(4), id: r.u16(8), parent: r.u16(10), next: r.u16(12), vertices: r.u16(14),
      units: r.u16(16), layer: r.u16(18), type: r.u32(4) & 0xF };
  }
  _set16(i, at, v) { new DataView(this.objects[i].buffer, this.objects[i].byteOffset).setUint16(at, v, this.le); }

  // ---- writer -----------------------------------------------------------------------------------------------
  build() {
    const le = this.le, w = new Writer(le, Math.max(1 << 16, this.src.length + 4096)), offsets = {};
    w.zeros(52);
    const putTri = () => {
      offsets.tri = w.length;
      w.u32(this.tri.length);
      for (const t of this.tri) w.u32(t);
      w.align(4);
    };
    if (!this.triLate) putTri();
    offsets.obj_def = w.length;
    const hdr = this.objHeader.slice();
    new DataView(hdr.buffer).setUint16(0, this.objects.length, le);
    w.bytes(hdr);
    for (const ob of this.objects) w.bytes(ob);
    w.align(4);
    offsets.status = w.length;
    w.u32(this.order.length);
    const newOff = new Int32Array(this.origOff.length).fill(-1), newOffNew = new Map();
    let moved = this.order.length !== this.origOff.length;
    for (let pos = 0; pos < this.order.length; pos++) {
      const id = this.order[pos], at = w.length;
      if (id >= 0 && !this.edited.has(id)) {
        w.bytes(this.src.subarray(this.origOff[id], this.origOff[id] + this.origSize[id]));
      } else {
        const b = this.block(id);
        let body = b.trailer.length;
        for (const p of b.packets) body += 4 + p.data.length;
        w.u16(b.count).u16(4 + body);
        for (const p of b.packets) w.u16(p.type).u16(4 + p.data.length).bytes(p.data);
        w.bytes(b.trailer);
      }
      if (id >= 0) { newOff[id] = at; if (at !== this.origOff[id] || this.edited.has(id)) moved = true; }
      else newOffNew.set(id, at);
    }
    const target = ref => ref ? (ref.id >= 0 ? newOff[ref.id] : newOffNew.get(ref.id)) + ref.delta : null;
    w.align(4);
    offsets.action = w.length;
    w.u32(this.actions.length);
    const actOff = [];
    for (const a of this.actions) {
      actOff.push(w.length);
      const parts = [];
      let tlen = 0;
      for (const tr of a.tracks) {
        let keys;
        if (tr.keys) {
          const kw = new Writer(le, 256);
          for (const k of tr.keys) {
            const d = k.data.slice(), t = target(k.ref);
            if (t !== null && t >= 0) new DataView(d.buffer).setUint32(k.type === 7 ? 0 : 4, t, le);
            kw.u16(k.type).u16(4 + d.length).bytes(d);
          }
          kw.bytes(tr.tail || EMPTY);
          keys = kw.result();
        } else if (moved) {          // remap targets inside a copy of the raw keys
          keys = tr.raw.slice();
          const dv = new DataView(keys.buffer);
          let q = 0;
          for (let j = 0; j < tr.nkeys && q + 4 <= keys.length; j++) {
            const kt = dv.getUint16(q, le), ks = dv.getUint16(q + 2, le);
            if ((kt === 7 && ks >= 8) || (kt === 8 && ks >= 12)) {
              const at = q + (kt === 7 ? 4 : 8), res = this._resolve(dv.getUint32(at, le));
              const t = res ? target(res) : null;
              if (t !== null && t >= 0) dv.setUint32(at, t, le);
            }
            if (ks === 0) break;
            q += ks;
          }
        } else keys = tr.raw;
        const nk = tr.keys ? tr.keys.length : tr.nkeys;
        parts.push(pack(le, 'HHI', tr.object, nk, 8 + keys.length), keys);
        tlen += 8 + keys.length;
      }
      const n = 8 + tlen + a.tail.length;
      const size = n - a.tail.length === a.lenOrig ? a.sizeRaw : n & 0xFFFF;
      w.u16(a.tracks.length).u16(a.flags).u16(size).u16(a.b);
      for (const part of parts) w.bytes(part);
      w.bytes(a.tail);
    }
    w.align(4);
    offsets.action_table = w.length;
    const rows = [...this.actionTable].sort((x, y) => x[0] - y[0]);     // the game binary-searches it
    w.u32(rows.length);
    for (const [h, ai] of rows) w.u32(h).u32(typeof ai === 'number' ? actOff[ai] : ai.raw);
    if (this.triLate) { w.align(4); putTri(); }
    const raw = { ...this.raw };
    if (this.color_tbl) raw.color_tbl = this._packLists(this.color_tbl, this.colorTail);
    if (this.uv_tbl) raw.uv_tbl = this._packLists(this.uv_tbl, this.uvTail);
    if (this.tex_tbl) {
      const tw = new Writer(le);
      tw.u32(this.tex_tbl.length);
      for (const [h, t] of this.tex_tbl) tw.u32(h).u32(t);
      tw.bytes(this.texTail);
      raw.tex_tbl = tw.result();
    }
    if (this.layers) {
      const lw = new Writer(le);
      lw.u32(this.layers.length);
      for (const [h, s, c] of this.layers) lw.u32(h).u16(s).u16(c);
      lw.bytes(this.layerTail);
      raw.layer = lw.result();
    }
    for (const k of RAW) {
      w.align(4);
      offsets[k] = raw[k].length ? w.length : 0;
      w.bytes(raw[k]);
    }
    const out = w.result();
    const dv = new DataView(out.buffer);
    dv.setUint32(0, this.version, le);
    SLOTS.forEach((n, i) => dv.setUint32(4 + 4 * i, offsets[n] || 0, le));
    return out;
  }

  // ---- bookkeeping the game sizes its memory with -------------------------------------------------------------
  /** tagLA2_OBJ_DEF_HEADER: objects, vertices (strips), units, matrix / base-colour / texture / TRI / alpha-register
   *  slots, String objects, then one count per object type. */
  recount(texturedAdded = 0) {
    const objs = this.objects.map((_, i) => this.obj(i));
    const flag = bit => objs.filter(o => o.flags & bit).length;
    const dv = new DataView(this.objHeader.buffer, this.objHeader.byteOffset);
    const h = [];
    for (let i = 0; i < 22; i++) h.push(dv.getUint16(2 * i, this.le));
    h[0] = objs.length;
    h[1] = objs.filter(o => o.type === 8 || o.type === 9).reduce((a, o) => a + o.vertices, 0);
    const c = h.slice(2);
    c[0] = objs.filter(o => o.type === 9).reduce((a, o) => a + o.units, 0);
    c[1] = c[2] = flag(0x2000000);
    c[4] = flag(0x40000);
    c[3] = Math.max(c[3] + texturedAdded, c[4]);
    c[5] = flag(0x1000000);
    c[6] = objs.filter(o => o.type === 10).length;
    for (let t = 0; t < 12; t++) c[7 + t] = objs.filter(o => o.type === t).length;
    c[17] = objs.filter(o => o.type === 10).length;
    [...h.slice(0, 2), ...c].forEach((v, i) => dv.setUint16(2 * i, v, this.le));
  }
  layerCounts() {
    if (!this.layers) return;
    const n = new Array(this.layers.length).fill(0);
    this.objects.forEach((_, k) => { const l = this.obj(k).layer; if (l < n.length) n[l]++; });
    this.layers.forEach((l, i) => { l[2] = n[i]; });
  }
  relink() {
    const info = this.objects.map((_, i) => this.obj(i));
    const kids = new Map(), parent = new Map();
    for (const o of info) {
      if (!kids.has(o.parent)) kids.set(o.parent, []);
      kids.get(o.parent).push(o.id);
      parent.set(o.id, o.parent);
    }
    const nextAfter = oid => {
      while (oid) {
        const sib = kids.get(parent.get(oid)), i = sib.indexOf(oid);
        if (i + 1 < sib.length) return sib[i + 1];
        oid = parent.get(oid);
      }
      return 0;
    };
    info.forEach((o, i) => this._set16(i, 12, nextAfter(o.id)));
  }
  _finish(textured = 0) { this.layerCounts(); this.relink(); this.recount(textured); }

  // ---- edits ------------------------------------------------------------------------------------------------
  /** Delete object `index` and its descendants with their initial blocks, their tracks and the key blocks only those
   *  tracks used. Ids are renumbered 1..N (the game indexes objects by id). Returns the number removed. */
  delete(index) {
    const n0 = this.objects.length, info = this.objects.map((_, i) => this.obj(i));
    const dead = new Set([info[index].id]);
    for (const o of info) if (dead.has(o.parent)) dead.add(o.id);
    const keep = info.map((_, i) => i).filter(i => !dead.has(info[i].id));
    const newId = new Map(keep.map((i, k) => [info[i].id, k + 1]));
    const deadIds = new Set();
    info.forEach((o, i) => { if (dead.has(o.id)) deadIds.add(this.order[i]); });
    const live = new Set(), byDead = new Set();
    for (const a of this.actions) for (const tr of a.tracks) {
      const s = dead.has(tr.object) ? byDead : live;
      for (const id of this._refIds(tr)) s.add(id);
    }
    for (const id of byDead) if (!live.has(id)) deadIds.add(id);
    for (const a of this.actions) {
      a.tracks = a.tracks.filter(tr => !dead.has(tr.object));
      for (const tr of a.tracks) if (newId.has(tr.object)) tr.object = newId.get(tr.object);
    }
    this.order = this.order.filter(id => !deadIds.has(id));
    this.objects = keep.map(i => {
      const ob = this.objects[i].slice(), dv = new DataView(ob.buffer);
      dv.setUint16(8, newId.get(info[i].id), this.le);
      dv.setUint16(10, newId.get(info[i].parent) || 0, this.le);
      return ob;
    });
    this._finish();
    return n0 - keep.length;
  }

  /** Copy object `index` and its descendants to the end (new ids) with their initial blocks, offset by dx, dy
   *  (1/16 px). Returns the copy's index. */
  duplicate(index, dx = 0, dy = 0, parent = null) {
    const le = this.le, n0 = this.objects.length;
    const info = this.objects.map((_, i) => this.obj(i));
    const byId = new Map(info.map((o, i) => [o.id, i]));
    const rootId = info[index].id, order = [], stack = [rootId];
    while (stack.length) {
      const oid = stack.shift();
      order.push(oid);
      stack.unshift(...info.filter(o => o.parent === oid).map(o => o.id));
    }
    const maxId = Math.max(...byId.keys());
    const newId = new Map(order.map((old, k) => [old, maxId + 1 + k]));
    let textured = 0;
    const ids = order.map(old => {
      const src = byId.get(old), ob = this.objects[src].slice(), dv = new DataView(ob.buffer), o = info[src];
      dv.setUint16(8, newId.get(old), le);
      dv.setUint16(10, old === rootId ? (parent !== null ? parent : o.parent) : newId.get(o.parent), le);
      this.objects.push(ob);
      if (o.flags & 0x40000) textured++;
      const b = this.block(this.order[src]);
      const nb = { count: b.count, packets: b.packets.map(p => ({ type: p.type, data: p.data.slice() })), trailer: b.trailer.slice() };
      if (old === rootId && (dx || dy)) for (const p of nb.packets) if (p.type === 3) shiftPoints(p, dx, dy, le, true);
      return this._newBlock(nb);
    });
    this._insertBlocks(n0, ids);
    this._finish(textured);
    return n0;
  }

  /** New object of libla type `typ` under object id `parent` (0 = root); x, y, w, h in 1/16 px. Returns its index. */
  addObject(typ, { parent = 0, x = 0, y = 0, w = 1024, h = 768, name = null, texture = 1, uv = 0, text = 'TEXT',
    textLayout = [0, 0, 1], color = [0x80, 0x80, 0x80, 0x80], blend = 0x1010, points = null } = {}) {
    const le = this.le, P = (fmt, ...v) => pack(le, fmt, ...v);
    const info = this.objects.map((_, i) => this.obj(i));
    const byId = new Map(info.map((o, i) => [o.id, i]));
    const id = (byId.size ? Math.max(...byId.keys()) : 0) + 1;
    const layer = byId.has(parent) ? info[byId.get(parent)].layer : 0;
    if (!points) {
      points = { 5: [[0, 0], [w, 0], [0, h]], 6: [[0, 0], [w, 0], [w, h], [0, h]], 7: [[0, 0], [w, 0]],
        8: [[0, 0], [w >> 1, h], [w, 0]], 9: [[0, 0], [w, 0], [w, h], [0, h]], 4: [[0, 0], [w, 0], [w, h], [0, h]] }[typ] || [[0, 0]];
    }
    const multi = [4, 5, 6, 7, 8, 9].includes(typ), nv = multi ? points.length : 1;
    if (!this.color_tbl) this.color_tbl = [];
    const cidx = this.color_tbl.length;
    this.color_tbl.push(Array.from({ length: [5, 6, 7, 8, 9].includes(typ) ? nv : 1 }, () => Uint8Array.from(color)));
    const pts = multi ? points.map(([px, py]) => [x + px, y + py]) : [[x, y]];
    const packets = [{ type: 3, data: concat([P('IHH', 1, pts.length, 0), ...pts.map(pt => P('hh', ...pt))]) }];
    if ([2, 3, 10, 11].includes(typ)) packets.push({ type: 5, data: P('Ihh', 1, w, h) });
    packets.push({ type: 6, data: P('IHH', 1, 0, 0xF000 | cidx) }, { type: 1, data: EMPTY });
    if (typ <= 1) {
      packets.push({ type: 10, data: P('I', 0x100) }, { type: 9, data: P('I', blend) }, { type: 11, data: P('hh', 0, 1) });
    } else {
      if ([3, 4, 9, 10, 11].includes(typ)) packets.push({ type: 7, data: P('I', texture) });
      if ([3, 4, 9].includes(typ)) packets.push({ type: 8, data: P('I', uv) });
      packets.push({ type: 9, data: P('I', blend) });
      if (typ === 10 || typ === 11) packets.push({ type: 24, data: P('hhhh', ...textLayout, 0) }, textPacket(le, text));
    }
    packets.push({ type: 0, data: EMPTY });
    this.objects.push(concat([P('IIHHHHHH', strcode(name || 'obj' + id), (NEW_FLAGS[typ] || 0x3000000) | typ, id, parent, 0,
      nv, typ === 9 ? 1 : 0, layer), typ === 9 ? P('HH', 0, nv) : EMPTY]));
    const n0 = this.objects.length - 1;
    this._insertBlocks(n0, [this._newBlock({ count: packets.length, packets, trailer: EMPTY })]);
    this._finish([3, 4, 9, 10, 11].includes(typ) ? 1 : 0);
    return n0;
  }

  /** Shift every point of object `index`'s initial position by dx, dy (1/16 px). */
  move(index, dx, dy) {
    const id = this.order[index], b = this.block(id);
    const p = b.packets.find(q => q.type === 3);
    if (!p) return false;
    shiftPoints(p, dx, dy, this.le, false);
    this._putBlock(id, b);
    return true;
  }

  /** Replace the string of a block's text packet (the nth one, any length). */
  setText(pos, text, nth = 0) {
    const id = this.order[pos], b = this.block(id);
    const i = b.packets.findIndex(q => q.type === 13 && nth-- === 0);
    if (i < 0) return false;
    b.packets[i] = textPacket(this.le, text);
    this._putBlock(id, b);
    return true;
  }

  /** Replace a block's packets ([{type, data}]); keeps the end packet and usPacketCount consistent. */
  setPackets(pos, packets) {
    const pk = packets.map(p => ({ type: p.type, data: p.data }));
    if (!pk.length || pk[pk.length - 1].type !== 0) pk.push({ type: 0, data: EMPTY });
    const id = this.order[pos], b = this.block(id);
    this._putBlock(id, { count: pk.length, packets: pk, trailer: b.trailer });
  }

  /** Keys of a track for the editor: [{type, data, pos}] with set / morph targets as block positions. */
  keysForEdit(action, track) {
    const posOf = this._posOf();
    return this.trackKeys(this.actions[action].tracks[track]).map(k => ({ type: k.type, data: k.data,
      pos: k.ref ? posOf.get(k.ref.id) : null, delta: k.ref ? k.ref.delta : 0 }));
  }
  _posOf() { const m = new Map(); this.order.forEach((id, pos) => m.set(id, pos)); return m; }

  /** Replace a track's keys ([{type, data, pos}]); set / morph point at the block at position pos. */
  setKeys(action, track, keys) {
    const out = keys.map(k => {
      const key = { type: k.type, data: k.data, ref: null };
      if (k.type === 7 || k.type === 8) {
        const need = k.type === 7 ? 4 : 8;
        if (key.data.length < need) { const d = new Uint8Array(need); d.set(key.data); key.data = d; }
        if (k.pos !== null && k.pos !== undefined && k.pos !== '' && +k.pos < this.order.length) key.ref = { id: this.order[+k.pos], delta: k.delta || 0 };
      }
      return key;
    });
    if (!out.length || out[out.length - 1].type !== 0) out.push({ type: 0, data: EMPTY });
    const tr = this.actions[action].tracks[track];
    this.trackKeys(tr);
    tr.keys = out;
  }

  setActionLoop(action, loop) { this.actions[action].flags = loop ? 1 : 0; }
}

function shiftPoints(p, dx, dy, le, firstOnly) {
  const d = p.data.slice(), dv = new DataView(d.buffer);
  const n = dv.getUint32(0, le);
  let o = 4;
  for (let i = 0; i < n; i++) {
    const cnt = dv.getUint16(o, le);
    for (let k = 0; k < (firstOnly ? Math.min(1, cnt) : cnt); k++) {
      const q = o + 4 + 4 * k;
      dv.setInt16(q, Math.max(-32768, Math.min(32767, dv.getInt16(q, le) + dx)), le);
      dv.setInt16(q + 2, Math.max(-32768, Math.min(32767, dv.getInt16(q + 2, le) + dy)), le);
    }
    if (firstOnly) break;
    o += 4 + 4 * cnt;
  }
  p.data = d;
}

function textPacket(le, text) {
  const raw = latin1.encode(text), body = new Uint8Array((raw.length + 1 + 3) & ~3);
  body.set(raw);
  return { type: 13, data: concat([pack(le, 'I', raw.length), body]) };
}
