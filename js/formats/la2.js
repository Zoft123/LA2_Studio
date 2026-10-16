// LA2: libla's 2D layout / animation format (HUDs, menus, icons, telops) used by the MGS4 engine.
//
// header   u32 version (0x00010008 / 0x00010009), then 12 section offsets (tagLA2_HEADER):
//          ofObj, ofStat, ofAct, ofActTbl, ofTri, ofKeyName, ofTexTbl, ofColorTbl, ofUVTbl, ofCtrlVtTbl, ofFont, ofLayer
// objects  tagLA2_OBJ_DEF_HEADER (22 x u16 counts), then per object tagLA2_OBJECT {u32 strcode, u32 type (low
//          nibble = object type, high bits = flags), u16 id, u16 parent, u16 view-next id, u16 vertex count,
//          u16 unit count, u16 layer}, then unit count x {u16 unit, u16 vertex count}
// status   u32 count; block {u16 packet count, u16 size, packets}; packet {u16 type, u16 size, data}.
//          Blocks 0..objects-1 are the objects' initial states, later blocks are targets of action keys.
// actions  u32 count; action {u16 tracks, u16 flags (loop), u16 size, u16 ?}; track {u16 object id, u16 keys,
//          u32 size}; key {u16 type, u16 size, data}
// Files are big-endian on PS3; the PC game (Metal Gear Arcade) ships them little-endian.
import { Reader, latin1 } from '../core/bin.js';

export const SECTIONS = ['obj_def', 'status', 'action', 'action_table', 'tri', 'keyname', 'tex_tbl', 'color_tbl',
  'uv_tbl', 'ctrl_vertex_tbl', 'font', 'layer'];
export const SECTION_NAMES = ['ofObj', 'ofStat', 'ofAct', 'ofActTbl', 'ofTri', 'ofKeyName', 'ofTexTbl', 'ofColorTbl',
  'ofUVTbl', 'ofCtrlVtTbl', 'ofFont', 'ofLayer'];
export const OBJ_DEF_NAMES = ['usObjectCount', 'usVertexCount', 'usUnitCount', 'usMatrixCount', 'usBaseColorCount',
  'usTexCount', 'usLoadTRICount', 'usAlphaRegCount', 'usCallCount', 'usEmptyCount', 'usCtrlCount', 'usBoxCount',
  'usSprtCount', 'usRsprtCount', 'usTriangleCount', 'usQuadCount', 'usLineCount', 'usLineStripCount',
  'usTriangleStripCount', 'usStringCount', 'usTypingCount', 'usPad'];

export const OBJ_TYPES = { 0: 'Nul', 1: 'Ctrl', 2: 'Box', 3: 'Sprt', 4: 'RSprt', 5: 'Triangle', 6: 'Quad', 7: 'Line',
  8: 'LineStrip', 9: 'TriangleStrip', 10: 'String', 11: 'Typing' };

export const PACKETS = { 0: 'end', 1: 'show', 2: 'hide', 3: 'xy', 4: 'xy_add', 5: 'wh', 6: 'rgba', 7: 'texture',
  8: 'uv', 9: 'blend', 10: 'scale', 11: 'rotate', 12: 'spin_center', 13: 'text', 14: 'string_space', 15: 'name',
  16: 'ctrl_vertex', 17: 'typing_mode', 18: 'font', 19: 'string_pos_mode', 20: 'typing_speed',
  21: 'typing_color_speed', 22: 'typing_first_color', 23: 'typing_end_color', 24: 'text_layout',
  25: 'typing_init_data' };

export const KEYS = { 0: 'end', 1: 'commands', 2: 'call', 3: 'return', 4: 'wait', 7: 'set', 8: 'morph' };
export const BLEND = { 0x1010: 'normal', 0x1020: 'add', 0x2001: 'sub', 0x22: 'none' };

export function parsePacket(r, off) {
  const type = r.u16(off), size = r.u16(off + 2);
  const p = { type, name: PACKETS[type] || 'p' + type, size, offset: off };
  const body = off + 4;
  if (type === 3 || type === 4) {
    const n = r.u32(body);
    const lists = [];
    let o = body + 4;
    for (let i = 0; i < n; i++) {
      const cnt = r.u16(o), tag = r.u16(o + 2);
      const points = [];
      for (let k = 0; k < cnt; k++) points.push([r.i16(o + 4 + 4 * k), r.i16(o + 6 + 4 * k)]);
      lists.push({ tag, points });
      o += 4 + 4 * cnt;
    }
    p.lists = lists;
  } else if (type === 5 || type === 16) {
    const n = r.u32(body);
    p.values = [];
    for (let i = 0; i < n; i++) p.values.push([r.i16(body + 4 + 4 * i), r.i16(body + 6 + 4 * i)]);
  } else if (type === 6) {
    const n = r.u32(body);
    p.colors = [];
    for (let i = 0; i < n; i++) {
      const b = r.u16(body + 6 + 4 * i);
      p.colors.push({ target: r.u16(body + 4 + 4 * i), color: b & 0xFFF, mask: b >> 12 });
    }
  } else if (type === 11) {
    p.values = [r.i16(body), r.i16(body + 2)];
  } else if (type === 25) {
    p.values = [r.i16(body), r.i16(body + 2), r.u32(body + 4), r.u32(body + 8)];
  } else if (type === 13) {
    const n = r.u32(body);
    p.text = r.slice(body + 4, n);
  } else if (type === 24) {
    p.values = [r.i16(body), r.i16(body + 2), r.i16(body + 4)];
  } else if ([14, 17, 18, 19, 20, 21].includes(type)) {
    p.value = r.i16(body);
  } else if (type === 22 || type === 23) {
    p.value = r.u32(body);
  } else if (size >= 8) {
    p.value = r.u32(body);
    if (type === 9) p.blend = BLEND[p.value] || '0x' + p.value.toString(16);
  }
  return p;
}

export function parseKey(r, off) {
  const type = r.u16(off), size = r.u16(off + 2);
  const k = { type, name: KEYS[type] || 'k' + type, size, offset: off };
  if (type === 1) {
    const n = r.u32(off + 4);
    k.commands = [];
    for (let i = 0; i < n; i++) k.commands.push([r.u32(off + 8 + 8 * i), r.u32(off + 12 + 8 * i)]);
  } else if (type === 2 || type === 4 || type === 7) {
    k.value = r.u32(off + 4);
  } else if (type === 8) {
    k.frames = r.u32(off + 4); k.status = r.u32(off + 8);
  }
  return k;
}

/** Action headers and track spans only; keys are decoded on demand (MGS4 layouts reach millions of keys). */
function scanActions(r, off) {
  const n = r.u32(off);
  const actions = [];
  let p = off + 4;
  for (let i = 0; i < n; i++) {
    const ntracks = r.u16(p), flags = r.u16(p + 2), size = r.u16(p + 4);
    const act = { index: i, offset: p, flags, tracks: [] };
    let t = p + 8;
    for (let k = 0; k < ntracks; k++) {
      const tsize = r.u32(t + 4);
      act.tracks.push({ object: r.u16(t), nkeys: r.u16(t + 2), offset: t, size: tsize });
      t += tsize || 8;
    }
    actions.push(act);
    // usSize is 16-bit and unused by libla; past 64 KB (or when stale) the end of the tracks is the action's end.
    p = size ? (p + size >= t ? p + size : t) : p + 8;
  }
  return actions;
}

function parseLists(r, off, rgba) {
  const count = r.u32(off), out = [];
  let o = off + 4;
  for (let i = 0; i < count; i++) {
    const n = r.u16(o), size = r.u16(o + 2), l = [];
    for (let k = 0; k < n; k++) {
      if (rgba) l.push([r.u8(o + 4 + 4 * k), r.u8(o + 5 + 4 * k), r.u8(o + 6 + 4 * k), r.u8(o + 7 + 4 * k)]);
      else l.push([r.u16(o + 4 + 4 * k), r.u16(o + 6 + 4 * k)]);
    }
    out.push(l);
    o += size || 4 + 4 * n;
  }
  return out;
}

export class LA2 {
  /** @param {Uint8Array} data */
  constructor(data) {
    const be = new Reader(data, false).u32(0);
    this.le = !(be === 0x10008 || be === 0x10009);
    const r = this.r = new Reader(data, this.le);
    this.data = data;
    this.version = r.u32(0);
    if ((this.version & 0xFFFF0000) !== 0x10000) throw new Error('not an LA2 file');
    this.offsets = {};
    SECTIONS.forEach((n, i) => { this.offsets[n] = r.u32(4 + 4 * i); });
    this.objects = this._objects();
    this._indexStatus();
    this.tex_tbl = this._pairs('tex_tbl');
    this.tri = this._u32list('tri');
    this.color_tbl = this.offsets.color_tbl ? parseLists(r, this.offsets.color_tbl, true) : [];
    this.uv_tbl = this.offsets.uv_tbl ? parseLists(r, this.offsets.uv_tbl, false) : [];
    this.action_table = this._pairs('action_table');
    this.actions = this.offsets.action ? scanActions(r, this.offsets.action) : [];
    const byOff = new Map(this.actions.map(a => [a.offset, a.index]));
    this.named = new Map(this.action_table.filter(([, o]) => byOff.has(o)).map(([h, o]) => [h, byOff.get(o)]));
    this.actionHash = new Map([...this.named].map(([h, i]) => [i, h]));
    this.layers = this._layers();
    this.fonts = this._fonts();
  }
  _u32list(name) {
    const o = this.offsets[name];
    if (!o) return [];
    const n = this.r.u32(o), out = [];
    for (let i = 0; i < n; i++) out.push(this.r.u32(o + 4 + 4 * i));
    return out;
  }
  _pairs(name) {
    const o = this.offsets[name];
    if (!o) return [];
    const n = this.r.u32(o), out = [];
    for (let i = 0; i < n; i++) out.push([this.r.u32(o + 4 + 8 * i), this.r.u32(o + 8 + 8 * i)]);
    return out;
  }
  _objects() {
    const o = this.offsets.obj_def, r = this.r;
    const num = r.u16(o);
    this.obj_counts = [];
    for (let i = 0; i < 22; i++) this.obj_counts.push(r.u16(o + 2 * i));
    let p = o + 44;
    const objs = [];
    for (let i = 0; i < num; i++) {
      const hash = r.u32(p), flags = r.u32(p + 4), n = r.u16(p + 16);
      const units = [];
      for (let k = 0; k < n; k++) units.push([r.u16(p + 20 + 4 * k), r.u16(p + 22 + 4 * k)]);
      objs.push({
        index: i, hash, flags, type: flags & 0xF, type_name: OBJ_TYPES[flags & 0xF] || 'type' + (flags & 0xF),
        id: r.u16(p + 8), parent: r.u16(p + 10), next: r.u16(p + 12), vertices: r.u16(p + 14), layer: r.u16(p + 18),
        units, offset: p,
      });
      p += 20 + 4 * n;
    }
    return objs;
  }
  _indexStatus() {
    // block {u16 usPacketCount, u16 usSize, packets}; only offsets are indexed here
    const o = this.offsets.status;
    const n = o ? this.r.u32(o) : 0;
    this.blockOff = new Uint32Array(n);
    let p = o + 4;
    for (let i = 0; i < n; i++) { this.blockOff[i] = p; p += this.r.u16(p + 2) || 4; }
    this.nblocks = n;
  }
  blockSize(i) { return this.r.u16(this.blockOff[i] + 2); }
  /** [block index, offset into it] of a file offset that set / morph keys point at, or null. */
  blockAt(off) {
    const a = this.blockOff;
    let lo = 0, hi = a.length - 1;
    if (hi < 0 || off < a[0]) return null;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid] <= off) lo = mid; else hi = mid - 1; }
    return off < a[lo] + this.blockSize(lo) ? [lo, off - a[lo]] : null;
  }
  /** Decoded packets of block i (from `start`, for keys pointing inside a block). */
  packets(i, start = 0) {
    const r = this.r, off = this.blockOff[i], size = this.blockSize(i), out = [];
    let o = start ? off + start : off + 4;
    while (o < off + size) {
      const p = parsePacket(r, o);
      out.push(p);
      if (p.type === 0 || p.size === 0) break;
      o += p.size;
    }
    return out;
  }
  /** Decoded keys of one track. */
  keys(action, track, limit = Infinity) {
    const tr = this.actions[action].tracks[track], out = [];
    let q = tr.offset + 8;
    for (let j = 0; j < tr.nkeys && j < limit; j++) {
      const k = parseKey(this.r, q);
      out.push(k);
      if (k.size === 0 || k.type === 0) break;
      q += k.size;
    }
    return out;
  }
  _fonts() {
    // font {u32 strcode, u16 cells, u16 size}; cell {u16 w, u16 h (1/16 px), u16 u0, u16 u1, u16 v0, u16 v1
    // (0..65535 of the font texture), char[4] code}
    const o = this.offsets.font;
    if (!o) return [];
    const r = this.r, n = r.u32(o), fonts = [];
    let p = o + 4;
    for (let i = 0; i < n; i++) {
      const hash = r.u32(p), ng = r.u16(p + 4), size = r.u16(p + 6);
      const glyphs = new Map();
      for (let k = 0; k < ng; k++) {
        const g = p + 8 + 16 * k;
        let code = this.data.subarray(g + 12, g + 16);
        let e = code.length;
        while (e > 0 && code[e - 1] === 0) e--;
        glyphs.set(latin1.decode(code.subarray(0, e)), [r.u16(g), r.u16(g + 2), r.u16(g + 4), r.u16(g + 6), r.u16(g + 8), r.u16(g + 10)]);
      }
      fonts.push({ hash, glyphs });
      p += size || 8 + 16 * ng;
    }
    return fonts;
  }
  _layers() {
    // tagLA2_LAYER {u32 strcode, u16 usStatus (bit 0 = display off), u16 usObjectCount}
    const o = this.offsets.layer;
    if (!o) return [];
    const n = this.r.u32(o), out = [];
    for (let i = 0; i < n; i++) out.push([this.r.u32(o + 4 + 8 * i), this.r.u16(o + 8 + 8 * i), this.r.u16(o + 10 + 8 * i)]);
    return out;
  }
}

// ---- in-place field editing (values whose size never changes: patched at their file offset) ---------------------
const field = (label, offset, fmt, value) => ({ label, offset, fmt, value });

/** Editable fields of one status block, in file order. */
export function statusFields(la, blockIndex) {
  const r = la.r, out = [];
  let o = la.blockOff[blockIndex] + 4;
  for (const p of la.packets(blockIndex)) {
    const body = o + 4, n = p.name;
    if (p.type === 3 || p.type === 4) {
      let q = body + 4;
      p.lists.forEach((l, li) => {
        l.points.forEach((_, pi) => {
          out.push(field(`${n}[${li}][${pi}].x`, q + 4 + 4 * pi, 'h', r.i16(q + 4 + 4 * pi)));
          out.push(field(`${n}[${li}][${pi}].y`, q + 6 + 4 * pi, 'h', r.i16(q + 6 + 4 * pi)));
        });
        q += 4 + 4 * l.points.length;
      });
    } else if (p.type === 5 || p.type === 16) {
      p.values.forEach((_, i) => {
        out.push(field(`${n}[${i}].${p.type === 5 ? 'w' : 'a'}`, body + 4 + 4 * i, 'h', r.i16(body + 4 + 4 * i)));
        out.push(field(`${n}[${i}].${p.type === 5 ? 'h' : 'b'}`, body + 6 + 4 * i, 'h', r.i16(body + 6 + 4 * i)));
      });
    } else if (p.type === 6) {
      p.colors.forEach((_, i) => out.push(field(`rgba[${i}].color_index`, body + 6 + 4 * i, 'H', r.u16(body + 6 + 4 * i))));
    } else if ([7, 8, 9, 10].includes(p.type)) {
      out.push(field(n, body, 'I', r.u32(body)));
    } else if (p.type === 11) {
      out.push(field('rotate', body, 'h', r.i16(body)));
    } else if (p.type === 13) {
      const ln = r.u32(body);
      out.push(field('text', body + 4, ln + 's', latin1.decode(la.data.subarray(body + 4, body + 4 + ln))));
    } else if (p.type === 24) {
      ['space', 'align', 'font'].forEach((lab, i) => out.push(field('text_layout.' + lab, body + 2 * i, 'h', r.i16(body + 2 * i))));
    } else if (p.type === 1 || p.type === 2) {
      out.push(field('visibility (1 show, 2 hide)', o, 'H', p.type));
    }
    if (p.type === 0 || p.size === 0) break;
    o += p.size;
  }
  return out;
}

/** Same-size patch of one field. */
export function patch(la, offset, fmt, value) {
  const d = la.data.slice();
  const dv = new DataView(d.buffer);
  if (fmt.endsWith('s')) {
    const n = parseInt(fmt), raw = latin1.encode(String(value)).subarray(0, n);
    d.fill(0, offset, offset + n); d.set(raw, offset);
  } else if (fmt === '4B') {
    value.forEach((v, i) => { d[offset + i] = v & 0xFF; });
  } else if (fmt === 'h') dv.setInt16(offset, value, la.le);
  else if (fmt === 'H') dv.setUint16(offset, value, la.le);
  else if (fmt === 'I') dv.setUint32(offset, value >>> 0, la.le);
  return d;
}
