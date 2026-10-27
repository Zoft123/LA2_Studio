// Playback engine: object state, action playback, the command timeline and draw-list generation, following libla
// (the MGS4 engine's 2D layout library) as closely as it is understood.
//
//  - Positions are 1/16 px; rotation 4096 = full turn; scale 256 = 1.0; colours: RGB 0..255, alpha 0x80 = opaque (every
//    colour table of the 271 MGO2 layouts stores white as 255,255,255 and no alpha above 0x80).
//  - Draw order: layers by priority (initially their index; a layer whose status has bit 0 set is off), then
//    objects in file order. Children inherit position, rotation, scale and colour from Nul / Ctrl parents.
//  - Keys: set = apply a status block, morph = interpolate to it over n frames, wait = hold n frames,
//    commands = start / loop / stop actions and reorder layers (anything else is a signal for the game).
import { parsePacket } from '../formats/la2.js';
import { strcode, latin1 } from '../core/bin.js';

export const COMMANDS = new Map(['StartAction', 'StartLoopAction', 'StopAction', 'FrontLayer', 'BackLayer',
  'SwapLayer', 'Name'].map(n => [strcode(n), n]));

const lerp = (a, b, t) => a + (b - a) * t;

// ---- object state -------------------------------------------------------------------------------------------
const WHITE = [0xFF, 0xFF, 0xFF, 0x80];   // no colour set: opaque white

export class State {
  constructor() {
    this.visible = true;
    this.xy = [[[0, 0]]];
    this.wh = [[0, 0]];
    this.rgba = new Map();          // (target << 12 | i) -> [r, g, b, a] (RGB 0..255, alpha 0x80 = opaque)
    this.texture = 0;
    this.uv = null;
    this.blend = 'normal';
    this.scale = 256;
    this.rotate = 0;
    this.text = null;
    this.layout = [0, 0, 0];        // StringInitData: space.x, mode (0 left 1 right 2 centre 3 justify), font id
    this.typing = [0, 0, 0, 0];     // TypingInitData: type speed, colour speed, first / end colour (u32 RGBA)
    this.typingMode = 0;
    this.typingStart = 0;
  }
  clone() {
    const s = Object.assign(new State(), this);
    s.xy = this.xy.map(l => l.map(p => p.slice()));
    s.wh = this.wh.map(p => p.slice());
    s.rgba = new Map([...this.rgba].map(([k, v]) => [k, v.slice()]));
    s.layout = this.layout.slice();
    s.typing = this.typing.slice();
    return s;
  }
  /** Apply packets; t < 1 = part of a morph (only interpolating packets act). at = global frame (typing start). */
  apply(packets, la, t = 1, at = 0) {
    for (const p of packets) {
      const n = p.name;
      if (n === 'show') { if (t >= 1) this.visible = true; }
      else if (n === 'hide') { if (t >= 1) this.visible = false; }
      else if (n === 'xy') {
        let nw = p.lists.map(l => l.points.map(q => q.slice()));
        if (t < 1 && nw.length === this.xy.length)
          nw = nw.map((nl, i) => nl.length === this.xy[i].length ? nl.map((q, k) => [lerp(this.xy[i][k][0], q[0], t), lerp(this.xy[i][k][1], q[1], t)]) : nl);
        this.xy = nw;
      } else if (n === 'xy_add') {
        this.xy = this.xy.map((o, i) => p.lists[i] ? o.map((q, k) => p.lists[i].points[k] ? [q[0] + p.lists[i].points[k][0] * t, q[1] + p.lists[i].points[k][1] * t] : q) : o);
      } else if (n === 'wh') {
        let nw = p.values.map(v => v.slice());
        if (t < 1 && nw.length === this.wh.length) nw = nw.map((v, i) => [lerp(this.wh[i][0], v[0], t), lerp(this.wh[i][1], v[1], t)]);
        this.wh = nw;
      } else if (n === 'rgba') {
        for (const c of p.colors) {
          const lst = la.color_tbl[c.color] || [];
          lst.forEach((nc, i) => {
            const key = (c.target << 12) | i, old = this.rgba.get(key) || WHITE, out = old.slice();
            [8, 4, 2, 1].forEach((bit, ch) => { if (c.mask & bit) out[ch] = t < 1 ? lerp(old[ch], nc[ch], t) : nc[ch]; });
            this.rgba.set(key, out);
          });
        }
      } else if (n === 'texture') { if (t >= 1) this.texture = p.value; }
      else if (n === 'uv') { if (t >= 1) this.uv = p.value; }
      else if (n === 'blend') this.blend = p.blend || 'normal';
      else if (n === 'scale') { const v = p.value & 0xFFFF; this.scale = t < 1 ? lerp(this.scale, v, t) : v; }
      else if (n === 'rotate') { const v = p.values[0]; this.rotate = t < 1 ? lerp(this.rotate, v, t) : v; }
      else if (t >= 1) {
        if (n === 'text') this.text = p.text;
        else if (n === 'text_layout') this.layout = p.values.slice();
        else if (n === 'string_space') this.layout[0] = p.value;
        else if (n === 'string_pos_mode') this.layout[1] = p.value;
        else if (n === 'font') this.layout[2] = p.value;
        else if (n === 'typing_init_data') this.typing = p.values.slice();
        else if (n === 'typing_speed') this.typing[0] = p.value;
        else if (n === 'typing_color_speed') this.typing[1] = p.value;
        else if (n === 'typing_mode') {
          if (p.value === 1 && this.typingMode !== 1) this.typingStart = at;
          this.typingMode = p.value;
        }
      }
    }
  }
  /** Colour i of the entry set on `unit`, as 0..1 floats (alpha 0x80 = 1.0, doubled and clamped). */
  color(i = 0, unit = 0) {
    const c = this.rgba.get((unit << 12) | i) || this.rgba.get(unit << 12) || this.rgba.get(i) || this.rgba.get(0) || WHITE;
    return [c[0] / 255, c[1] / 255, c[2] / 255, Math.min(255, c[3] * 2) / 255];
  }
}

// ---- compiled tracks ------------------------------------------------------------------------------------------
// A track's keys flattened into typed arrays (call keys inlined), read straight from the file bytes: MGS4 layouts
// have millions of keys. type / dur (frames) / block + delta (status target) per key; commands by key index.
const KEY_END = 0, KEY_CMD = 1, KEY_CALL = 2, KEY_RET = 3, KEY_WAIT = 4, KEY_SET = 7, KEY_MORPH = 8;

function rawKeys(la, action, track, depth, acc) {
  const tr = la.actions[action].tracks[track], r = la.r;
  let q = tr.offset + 8;
  for (let j = 0; j < tr.nkeys; j++) {
    const type = r.u16(q), size = r.u16(q + 2);
    if (type === KEY_CALL && depth < 8) {          // another action's first track, up to its return
      const sub = la.named.get(r.u32(q + 4));
      if (sub !== undefined && la.actions[sub].tracks.length) {
        const inner = { type: [], dur: [], block: [], delta: [], cmds: new Map() };
        rawKeys(la, sub, 0, depth + 1, inner);
        for (let k = 0; k < inner.type.length; k++) {
          if (inner.type[k] === KEY_END || inner.type[k] === KEY_RET) break;
          if (inner.cmds.has(k)) acc.cmds.set(acc.type.length, inner.cmds.get(k));
          acc.type.push(inner.type[k]); acc.dur.push(inner.dur[k]); acc.block.push(inner.block[k]); acc.delta.push(inner.delta[k]);
        }
      }
    } else {
      let dur = 0, block = -1, delta = 0;
      if (type === KEY_WAIT) dur = r.u32(q + 4);
      else if (type === KEY_MORPH) dur = Math.max(1, r.u32(q + 4));
      if (type === KEY_SET || type === KEY_MORPH) {
        const at = la.blockAt(r.u32(q + (type === KEY_SET ? 4 : 8)));
        if (at) { block = at[0]; delta = at[1]; }
      }
      if (type === KEY_CMD) {
        const n = r.u32(q + 4), cmds = [];
        for (let i = 0; i < n; i++) cmds.push([r.u32(q + 8 + 8 * i), r.u32(q + 12 + 8 * i)]);
        acc.cmds.set(acc.type.length, cmds);
      }
      acc.type.push(type); acc.dur.push(dur); acc.block.push(block); acc.delta.push(delta);
      if (type === KEY_END) break;
    }
    if (size === 0) break;
    q += size;
  }
  return acc;
}

export function compileTrack(la, action, track) {
  const a = rawKeys(la, action, track, 0, { type: [], dur: [], block: [], delta: [], cmds: new Map() });
  return { n: a.type.length, type: Uint8Array.from(a.type), dur: Int32Array.from(a.dur), block: Int32Array.from(a.block),
    delta: Int32Array.from(a.delta), cmds: a.cmds };
}

export function trackLength(t) {
  let n = 0;
  for (let k = 0; k < t.n; k++) { if (t.type[k] === KEY_END || t.type[k] === KEY_RET) break; n += t.dur[k]; }
  return n;
}

// ---- timeline: which actions run when (commands), layer changes -------------------------------------------------
export class Timeline {
  /** mode for the first action: 'auto' (its loop flag), 'loop', 'once', 'pingpong'. `also`: actions that play
   *  alongside it, looping from frame 0, for screens the game composes from several actions at once. */
  constructor(la, root, mode = 'auto', { also = [], horizon = 20000 } = {}) {
    this.la = la; this.root = root; this.mode = mode; this.horizon = horizon;
    this.also = also.filter(a => a !== root && la.actions[a]);
    this.compiled = new Map();
    this.len = la.actions.map((_, i) => Math.max(0, ...this.tracks(i).map(trackLength)));
    // schedule far enough for the first action (and a ping-pong round trip of it)
    this.horizon = Math.max(horizon, 2 * this.len[root] + 1);
    this._schedule();
  }
  tracks(i) {
    if (!this.compiled.has(i)) this.compiled.set(i, this.la.actions[i].tracks.map((_, t) => compileTrack(this.la, i, t)));
    return this.compiled.get(i);
  }
  loops(i) { return !!this.la.actions[i].flags; }
  _commands(i) {
    const out = [];
    this.tracks(i).forEach((tk, t) => {
      if (!tk.cmds.size) return;
      let time = 0;
      for (let k = 0; k < tk.n; k++) {
        if (tk.type[k] === KEY_END || tk.type[k] === KEY_RET) break;
        if (tk.cmds.has(k)) for (const [c, arg] of tk.cmds.get(k)) out.push([time, c, arg, this.la.actions[i].tracks[t].object]);
        time += tk.dur[k];
      }
    });
    return out.sort((a, b) => a[0] - b[0]);
  }
  _schedule() {
    const rootLoop = { auto: this.loops(this.root), loop: true, once: false, pingpong: true }[this.mode] ?? false;
    this.runs = [{ action: this.root, start: 0, stop: null, loop: rootLoop, root: true },
      ...this.also.map(action => ({ action, start: 0, stop: null, loop: true }))];
    this.events = []; this.layerOps = [];
    const heap = [];
    const addRun = run => {
      const cmds = this._commands(run.action), n = this.len[run.action];
      const reps = run.loop && n > 0 ? Math.floor(this.horizon / n) + 1 : 1;
      for (let r = 0; r < reps; r++) {
        for (const [t, c, arg, obj] of cmds) {
          const g = run.start + r * n + t;
          if (g > this.horizon) break;
          heap.push([g, heap.length, run, c, arg, obj]);
        }
        if (run.start + r * n > this.horizon) break;
      }
      heap.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    };
    for (const run of [...this.runs]) addRun(run);
    while (heap.length) {
      const [g, , run, c, arg, obj] = heap.shift();
      if (run.stop !== null && g >= run.stop) continue;
      const name = COMMANDS.get(c) || '#' + c.toString(16).padStart(6, '0');
      this.events.push({ frame: g, name, arg, action: run.action });
      const target = this.la.named.get(arg);
      if ((name === 'StartAction' || name === 'StartLoopAction') && target !== undefined) {
        for (const r of this.runs) if (r.action === target && r.stop === null && !r.root) r.stop = g;
        const nr = { action: target, start: g, stop: null, loop: name === 'StartLoopAction' || this.loops(target) };
        this.runs.push(nr);
        addRun(nr);
      } else if (name === 'StopAction' && target !== undefined) {
        for (const r of this.runs) if (r.action === target && r.stop === null && r.start <= g) r.stop = g;
      } else if (name === 'FrontLayer' || name === 'BackLayer' || name === 'SwapLayer') {
        this.layerOps.push({ frame: g, op: name, object: obj, layer: arg });
      }
      if (this.runs.length > 500) break;
    }
  }
  /** Frames to show: the first action, or until the last non-looping action it starts has ended. */
  length() {
    let end = this.len[this.root] * (this.mode === 'pingpong' ? 2 : 1);
    for (const r of this.runs.slice(1)) if (!r.loop) end = Math.max(end, Math.min(r.stop ?? 1e9, r.start + this.len[r.action]));
    return Math.min(end, this.horizon);
  }
  /** Ping-pong plays the first action forward then backward: the frame actually shown. */
  mapFrame(f) {
    const n = this.len[this.root];
    if (this.mode !== 'pingpong' || !n) return f;
    const t = f % (2 * n);
    return t > n ? 2 * n - t : t;
  }
}

// ---- scene: states + incremental player ----------------------------------------------------------------------
const SNAPSHOT_EVERY = 120;

export class Scene {
  /** @param la LA2 reader  @param textures {lookup(hash) -> {w, h, ox, oy, iw, ih} | null} */
  constructor(la, textures) {
    this.la = la; this.tx = textures;
    this.objs = new Map(la.objects.map(o => [o.id, o]));
    this.order = new Map(la.objects.map((o, i) => [o.id, i]));
    this.children = new Map();
    for (const o of la.objects) {
      if (!this.children.has(o.parent)) this.children.set(o.parent, []);
      this.children.get(o.parent).push(o.id);
    }
    this.hidden = new Set();
    this.hiddenLayers = new Set();
    // runtime composition (e.g. the Weapon Select screen): patch(set) overrides object states at draw time,
    // attached scenes ({primitives()}) are drawn after this one
    this.patch = null;
    this.attached = [];
    this.initial = new Map();
    la.objects.forEach((o, i) => {
      const s = new State();
      if (i < la.nblocks) s.apply(la.packets(i), la, 1, 0);
      this.initial.set(o.id, s);
    });
    this.reset();
  }
  reset() {
    this.state = new Map([...this.initial].map(([k, v]) => [k, v.clone()]));
    this.layerPrio = new Map(this.la.layers.map((_, i) => [i, i]));
    this.frame = 0;
    this.timeline = null;
    this.cursor = null;
    this.snapshots = new Map();
  }
  /** Use this timeline for play(); resets playback. */
  setTimeline(tl) {
    this.reset();
    this.timeline = tl;
    this.cursors = tl ? tl.runs.map(r => ({ run: r, tracks: tl.tracks(r.action).map(() => ({ k: 0, time: 0, done: false })), lastLocal: -1, loops: 0 })) : [];
    this.at = -1;
  }
  _snap() {
    return { state: new Map([...this.state].map(([k, v]) => [k, v.clone()])),
      cursors: this.cursors.map(c => ({ ...c, tracks: c.tracks.map(t => ({ ...t })) })), at: this.at };
  }
  _restore(s) {
    this.state = new Map([...s.state].map(([k, v]) => [k, v.clone()]));
    this.cursors = s.cursors.map(c => ({ ...c, tracks: c.tracks.map(t => ({ ...t })) }));
    this.at = s.at;
  }
  /** Bring the scene to timeline frame f (any order; forward steps are incremental). */
  seek(f) {
    const tl = this.timeline;
    if (!tl) return;
    f = tl.mapFrame(f);
    if (f < this.at) {
      let best = null;
      for (const [fr, s] of this.snapshots) if (fr <= f && (!best || fr > best[0])) best = [fr, s];
      if (best) this._restore(best[1]); else { this.setTimelineKeepSnaps(); }
    }
    // advance in steps so snapshots exist for later backward seeks
    while (this.at < f) {
      const next = Math.min(f, (Math.floor(this.at / SNAPSHOT_EVERY) + 1) * SNAPSHOT_EVERY);
      this._advance(next);
      if (next % SNAPSHOT_EVERY === 0 && !this.snapshots.has(next)) this.snapshots.set(next, this._snap());
    }
    this._advance(f);
    this.frame = f;
  }
  setTimelineKeepSnaps() {
    const snaps = this.snapshots, tl = this.timeline;
    this.setTimeline(tl);
    this.snapshots = snaps;
  }
  /** Commit every key that has completed by frame f; remember morphs in progress (applied by overlay()). */
  _advance(f) {
    this.overlays = [];
    for (const c of this.cursors) {
      const r = c.run;
      if (r.start > f) continue;
      const tl = this.timeline, n = tl.len[r.action], tracks = tl.tracks(r.action);
      let local = (r.stop !== null ? Math.min(f, r.stop) : f) - r.start;
      // looping: each completed pass restarts the keys from the state the last pass left
      if (r.loop && n > 0) {
        const pass = Math.floor(local / n);
        while (c.loops < pass) {
          this._runTracks(c, tracks, n, r.start + c.loops * n, true);
          c.loops++;
          c.tracks.forEach(t => { t.k = 0; t.time = 0; t.done = false; });
        }
        local -= pass * n;
      }
      this._runTracks(c, tracks, local, r.start + c.loops * n, false);
    }
    this.at = f;
  }
  _runTracks(c, tracks, local, base, finish) {
    const la = this.la;
    tracks.forEach((tk, ti) => {
      const cur = c.tracks[ti];
      if (cur.done) return;
      const oid = la.actions[c.run.action].tracks[ti].object, st = this.state.get(oid);
      while (cur.k < tk.n) {
        const type = tk.type[cur.k], dur = tk.dur[cur.k], block = tk.block[cur.k], delta = tk.delta[cur.k];
        if (type === KEY_SET) {
          if (block >= 0 && st) st.apply(la.packets(block, delta), la, 1, base + cur.time);
        } else if (type === KEY_MORPH) {
          if (!finish && local < cur.time + dur) {
            if (block >= 0 && st) this.overlays.push([oid, block, delta, (local - cur.time) / dur, base + cur.time]);
            return;
          }
          if (block >= 0 && st) st.apply(la.packets(block, delta), la, 1, base + cur.time);
          cur.time += dur;
        } else if (type === KEY_WAIT) {
          if (!finish && local < cur.time + dur) return;
          cur.time += dur;
        } else if (type === KEY_END || type === KEY_RET) { cur.done = !finish; return; }
        cur.k++;
      }
      if (!finish) cur.done = true;
    });
  }
  /** Layer priorities after the timeline's layer commands up to the current frame. */
  _layers() {
    const prio = new Map(this.la.layers.map((_, i) => [i, i]));
    if (!this.timeline) return prio;
    let order = [...prio.keys()];
    const byHash = new Map(this.la.layers.map(([h], i) => [h, i]));
    for (const op of this.timeline.layerOps) {
      if (op.frame > this.frame) break;
      const o = this.objs.get(op.object);
      if (!o || !order.includes(o.layer)) continue;
      const L = o.layer, other = byHash.get(op.layer);
      if (op.op === 'SwapLayer' && other !== undefined) {
        const a = order.indexOf(L), b = order.indexOf(other);
        [order[a], order[b]] = [order[b], order[a]];
      } else if (op.op === 'FrontLayer' || op.op === 'BackLayer') {
        order = order.filter(x => x !== L);
        if (other === undefined || other === L) order = op.op === 'FrontLayer' ? [...order, L] : [L, ...order];
        else order.splice(order.indexOf(other) + (op.op === 'FrontLayer' ? 1 : 0), 0, L);
      }
    }
    return new Map(order.map((l, i) => [l, i]));
  }

  // ---- draw list ---------------------------------------------------------------------------------------------
  /** Primitives in draw order: {kind: 'fan' | 'lines', pts (px), uv (texture px) | null, tex, cols (per vertex
   *  rgba 0..1), blend, id}. */
  primitives() {
    const la = this.la;
    // states for this frame: committed state plus morphs in progress
    let state = this.state;
    if (this.overlays && this.overlays.length) {
      state = new Map(this.state);
      const cloned = new Set();
      for (const [id, block, delta, t, at] of this.overlays) {
        if (!state.has(id)) continue;
        if (!cloned.has(id)) { state.set(id, state.get(id).clone()); cloned.add(id); }
        state.get(id).apply(la.packets(block, delta), la, t, at);
      }
    }
    if (this.patch) {
      const base = state;
      state = new Map(base);
      this.patch((id, fn) => { const st = base.get(id); if (st) { const c = st.clone(); fn(c); state.set(id, c); } });
    }
    const prio = this._layers();
    const off = new Set([...la.layers.map(([, s], i) => (s & 1) ? i : -1).filter(i => i >= 0), ...this.hiddenLayers]);
    const out = [];
    const emit = (o, prim) => out.push([prio.get(o.layer) ?? 0, this.order.get(o.id), out.length, prim]);
    const walk = (id, M, col) => {
      const o = this.objs.get(id), st = state.get(id);
      if (!o || !st || !st.visible || this.hidden.has(id) || off.has(o.layer)) return;
      // libla dispatches on the type word's low byte and only accepts 0..11; MGS4's Flash-converted layouts mark
      // shapes with extra bits there (e.g. 0x3016): they are not drawn by the game (mask / guide shapes).
      if ((o.flags & 0xFF) > 0x0B && !this.showGuides) return;
      const t = o.type;
      const [x, y] = st.xy[0] && st.xy[0][0] ? st.xy[0][0] : [0, 0];
      const tf = pts => pts.map(([px, py]) => [M[0] * px + M[1] * py + M[2], M[3] * px + M[4] * py + M[5]]);
      if (t === 0 || t === 1) {
        const c2 = st.color(), nc = col.map((v, i) => v * c2[i]);
        const a = st.rotate * Math.PI / 2048, s = st.scale / 256, cs = Math.cos(a) * s, sn = Math.sin(a) * s;
        const tx = x / 16, ty = y / 16;
        const M2 = [M[0] * cs + M[1] * sn, -M[0] * sn + M[1] * cs, M[0] * tx + M[1] * ty + M[2],
          M[3] * cs + M[4] * sn, -M[3] * sn + M[4] * cs, M[3] * tx + M[4] * ty + M[5]];
        for (const ch of this.children.get(id) || []) walk(ch, M2, nc);
        return;
      }
      const own = st.color(), oc = col.map((v, i) => v * own[i]);
      if (t === 10 || t === 11) {
        for (const p of this._text(o, st, M, oc, x, y)) emit(o, p);
      } else if (t === 2 || t === 3) {
        const [w, h] = st.wh[0] || [0, 0];
        const pts = tf([[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([a, b]) => [a / 16, b / 16]));
        const tex = t === 3 ? this._uv(st, 4) : null;
        emit(o, { kind: 'fan', pts, uv: tex && tex.uv, tex: tex && tex.tex, cols: Array(4).fill(oc), blend: st.blend, id });
      } else if (t >= 4 && t <= 8) {
        const flat = st.xy.flat();
        if (flat.length) {
          const pts = tf(flat.map(([a, b]) => [a / 16, b / 16]));
          const tex = t === 4 ? this._uv(st, pts.length) : null;
          const cols = flat.map((_, i) => (t === 4 ? own : st.color(i)).map((v, c) => v * col[c]));
          emit(o, { kind: t === 7 || t === 8 ? 'lines' : 'fan', pts, uv: tex && tex.uv, tex: tex && tex.tex, cols, blend: st.blend, id });
        }
      } else if (t === 9) {
        const total = st.xy.reduce((a, l) => a + l.length, 0);
        const tex = this._uv(st, total);
        let k = 0;
        st.xy.forEach((l, ui) => {
          if (l.length >= 3) {
            const pts = tf(l.map(([a, b]) => [a / 16, b / 16]));
            const uv = tex && tex.uv && tex.uv.length >= k + l.length ? tex.uv.slice(k, k + l.length) : null;
            const cols = l.map((_, i) => st.color(i, ui).map((v, c) => v * col[c]));
            emit(o, { kind: 'fan', pts, uv, tex: uv ? tex.tex : null, cols, blend: st.blend, id });
          }
          k += l.length;
        });
      }
      for (const ch of this.children.get(id) || []) walk(ch, M, col);
    };
    for (const root of this.children.get(0) || []) walk(root, [1, 0, 0, 0, 1, 0], [1, 1, 1, 1]);
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const prims = out.map(e => e[3]);
    for (const a of this.attached) for (const p of a.primitives()) prims.push({ ...p, id: -1, ext: true });
    return prims;
  }

  _uv(st, n) {
    if (!st.texture) return null;
    const row = this.la.tex_tbl[st.texture - 1];
    if (!row) return null;
    const info = this.tx && this.tx.lookup(row[0]);
    if (!info) return null;
    if (st.uv === null || st.uv >= this.la.uv_tbl.length) return { tex: row[0], uv: null };
    let u = this.la.uv_tbl[st.uv].map(([a, b]) => this.la.version === 0x10009 ? [a + info.ox, b + info.oy] : [a, b]);
    if (u.length === 2 && n === 4) {
      const [[u0, v0], [u1, v1]] = u;
      u = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    }
    return { tex: row[0], uv: u };
  }

  /** CreateLetter: glyphs at font-cell size (1/16 px), x advancing by glyph width; lines end at \n, \r or the
   *  escapes and move down by the newline glyph's height; per line mode 0 left, 1 right, 2 centre, 3 justify. */
  layout(font, raw, boxW, space, mode) {
    const glyphs = font.glyphs;
    let lineH = 0;
    for (const g of glyphs.values()) lineH = Math.max(lineH, g[1]);
    const out = [];
    let line = [], x = 0, y = 0, i = 0;
    const endLine = () => {
      const n = line.length;
      if (!n) return;
      let off = 0, step = space;
      if (mode === 1) off = boxW - x - (n - 1) * space;
      else if (mode === 2) off = Math.trunc((boxW - x - (n - 1) * space) / 2);
      else if (mode === 3) { if (n === 1) off = Math.trunc((boxW - x) / 2); else step = Math.trunc((boxW - x) / (n - 1)); }
      line.forEach(([gx, gy, g], k) => out.push([gx + off + k * step, gy, g]));
    };
    const s = latin1.decode(raw);
    while (i < s.length) {
      const ch = s[i], esc = s.substr(i, 2) === '\\n' || s.substr(i, 2) === '\\r';
      if (ch === '\n' || ch === '\r' || esc) {
        endLine();
        const nl = glyphs.get(esc ? s.substr(i, 2) : ch);
        y += nl ? nl[1] : lineH;
        line = []; x = 0; i += esc ? 2 : 1;
        continue;
      }
      let found = false;
      for (const n of [4, 3, 2, 1]) {          // glyph codes are 1-4 bytes (ASCII, Shift-JIS / UTF-8): longest match
        const g = glyphs.get(s.substr(i, n));
        if (g) { line.push([x, y, g]); x += g[0]; i += n; found = true; break; }
      }
      if (!found) i++;
    }
    endLine();
    return out;
  }

  /** String / Typing glyph quads. Typing: mode 1 reveals one letter every type-speed frames after the mode was
   *  set, each fading from the first to the end colour over colour-speed frames; mode 3 / 4 shows the typed letters
   *  in the first / end colour; mode 0 shows none. */
  _text(o, st, M, col, x, y) {
    const la = this.la;
    if (!st.text || !la.fonts.length || !st.texture) return [];
    const row = la.tex_tbl[st.texture - 1];
    const info = row && this.tx && this.tx.lookup(row[0]);
    const [space, mode, fid] = st.layout;
    const font = la.fonts[fid > 0 ? fid - 1 : 0] || la.fonts[0];
    let letters = this.layout(font, st.text, st.wh[0] ? st.wh[0][0] : 0, space, mode);
    let cols = letters.map(() => col);
    if (o.type === 11) {
      const [speed, cspeed, first, end] = st.typing;
      const un = c => [(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255].map(v => v / 255);
      const c0 = un(first), c1 = un(end);
      const elapsed = st.typingMode === 1 ? this.frame - st.typingStart : 0;
      letters = letters.slice(0, Math.max(0, speed > 0 ? Math.floor(elapsed / speed) : 0));
      cols = letters.map((_, k) => {
        let c;
        if (st.typingMode === 3) c = c0;
        else if (st.typingMode === 4) c = c1;
        else { const r = cspeed > 0 ? Math.min(1, (elapsed - (k + 1) * speed) / cspeed) : 1; c = c0.map((a, i) => lerp(a, c1[i], r)); }
        return c.map((v, i) => v * col[i]);
      });
    }
    const out = [];
    letters.forEach(([gx, gy, [w, h, u0, u1, v0, v1]], k) => {
      const lx = (x + gx) / 16, ly = (y + gy) / 16, gw = w / 16, gh = h / 16;
      const pts = [[lx, ly], [lx + gw, ly], [lx + gw, ly + gh], [lx, ly + gh]]
        .map(([px, py]) => [M[0] * px + M[1] * py + M[2], M[3] * px + M[4] * py + M[5]]);
      let uv = null;
      if (info) {
        const tw = info.w || info.iw, th = info.h || info.ih;
        const U0 = info.ox + u0 / 65535 * tw, U1 = info.ox + u1 / 65535 * tw, V0 = info.oy + v0 / 65535 * th, V1 = info.oy + v1 / 65535 * th;
        uv = [[U0, V0], [U1, V0], [U1, V1], [U0, V1]];
      }
      out.push({ kind: 'fan', pts, uv, tex: info ? row[0] : null, cols: Array(4).fill(cols[k]), blend: st.blend, id: o.id });
    });
    return out;
  }

  /** Bounds (px) of the initial layout, padded: the fixed view for every frame. */
  bounds() {
    if (this._bounds) return this._bounds;
    const keep = [this.state, this.overlays, this.frame];
    this.state = new Map([...this.initial].map(([k, v]) => [k, v.clone()]));
    this.overlays = [];
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of this.primitives()) for (const [x, y] of p.pts) {
      lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
    }
    [this.state, this.overlays, this.frame] = keep;
    if (!isFinite(lo[0])) { lo = [0, 0]; hi = [64, 64]; }
    return (this._bounds = { x: lo[0] - 8, y: lo[1] - 8, w: hi[0] - lo[0] + 16, h: hi[1] - lo[1] + 16 });
  }
  /** Grow the fixed view to cover what the timeline shows along the way (32 samples and its last frame): objects
   *  can move outside the initial layout (the lobby rule_anime's soldiers run in from its left edge and Snake ends
   *  past it). Fully transparent primitives don't count. No timeline: the initial view. */
  fitTimeline(samples = 32) {
    const b = this._initialBounds || (this._initialBounds = { ...this.bounds() });
    this._bounds = b;
    if (!this.timeline) return;
    const n = this.timeline.length();
    let lo = [b.x, b.y], hi = [b.x + b.w, b.y + b.h];
    for (let i = 1; i <= samples; i++) {
      this.seek(Math.round(n * i / samples));
      for (const p of this.primitives()) if (p.cols.some(c => c[3] > 0)) for (const [x, y] of p.pts) {
        lo = [Math.min(lo[0], x - 8), Math.min(lo[1], y - 8)]; hi = [Math.max(hi[0], x + 8), Math.max(hi[1], y + 8)];
      }
    }
    this._bounds = { x: lo[0], y: lo[1], w: hi[0] - lo[0], h: hi[1] - lo[1] };
  }
}
