// LA3 behavior confirmed in the PSP executable: point morphs, angles, signed scale, callback and action keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { State, Scene, Timeline, compileTrack } from '../js/engine/scene.js';
import { Reader, Writer, strcode } from '../js/core/bin.js';

const pw = { la3: {}, uv_tbl: [[[0, 0], [160, 160]], [[0xFFFF, 1], [175, 145]]], color_tbl: [[[99, 101, 100, 128]]] };
const uv = value => ({ name: 'uv', value });
const rotate = raw => ({ name: 'rotate', values: [raw, 0] });

test('LA3 points, sizes and String spacing use the normal direction-rounded morph handler', () => {
  const st = new State();
  st.apply([{ name: 'xy', lists: [{ points: [[3, -3]] }] }, { name: 'wh', values: [[3, -3]] },
    { name: 'string_space', value: 3 }], pw, 0.5);
  assert.deepEqual(st.xy, [[[2, -2]]]);
  assert.deepEqual(st.wh, [[2, -2]]);
  assert.equal(st.layout[0], 2);
  st.apply([{ name: 'xy', lists: [{ points: [[-3, -3]] }] }], pw);
  st.apply([{ name: 'xy', lists: [{ points: [[-2, -2]] }] }], pw, 0.5);
  assert.deepEqual(st.xy, [[[-2, -2]]]);  // round by slope, unlike round-by-result-sign
  const la2 = new State();
  la2.apply([{ name: 'xy', lists: [{ points: [[3, -3]] }] }, { name: 'string_space', value: 3 }], {}, 0.5);
  assert.deepEqual(la2.xy, [[[2, -2]]]);
  assert.equal(la2.layout[0], 0);
});

test('LA3 UV morphs have independent signed point lists, including cloned states', () => {
  const st = new State();
  st.apply([uv(0)], pw);
  const copy = st.clone();
  copy.apply([uv(1)], pw, 0.5);
  assert.deepEqual(copy.uvPoints, [[-1, 1], [168, 152]]);
  assert.deepEqual(st.uvPoints, [[0, 0], [160, 160]]);
  assert.deepEqual(pw.uv_tbl[0], [[0, 0], [160, 160]]);
  copy.apply([uv(1)], pw);
  assert.deepEqual(copy.uvPoints, [[-1, 1], [175, 145]]);
  const tx = { lookup: () => ({ u0: 0, v0: 0, uw: 10, vh: 10, lw: 10, lh: 10 }) };
  copy.texture = 1;
  const mapped = Scene.prototype._uv.call({ la: { ...pw, texKeys: ['texture'], uvUnit: 16 }, tx }, copy, 2);
  assert.deepEqual(mapped.uv, [[-1 / 16, 1 / 16], [175 / 16, 145 / 16]]);
});

test('LA3 scale is signed and scalar rounding follows the direction of change', () => {
  const st = new State();
  st.apply([{ name: 'scale', value: 0xFF00 }], pw);
  assert.equal(st.scale, -256);
  st.apply([{ name: 'scale', value: 0xFF00 }], pw, 0.5);
  assert.equal(st.scale, -256);
  st.scale = 100;
  st.rgba.set(0, [100, 100, 100, 128]);
  st.apply([{ name: 'scale', value: 99 }, { name: 'rgba', colors: [{ color: 0, target: 0, mask: 15 }] }], pw, 0.5);
  assert.equal(st.scale, 99);
  assert.deepEqual(st.rgba.get(0), [99, 101, 100, 128]);
  const la2 = new State();
  la2.apply([{ name: 'scale', value: 0xFF00 }], {});
  assert.equal(la2.scale, 65280);
});

test('LA3 rotation preserves raw 16-bit precision, drawing sign and shortest-arc interpolation', () => {
  const st = new State();
  st.apply([rotate(1)], pw);
  assert.equal(st.rotate, -1 / 16);
  st.apply([rotate(-32000)], pw);
  st.apply([rotate(32000)], pw, 0.5);
  assert.equal(st.rotate, -2048);               // +2000 to -2000 crosses the half-turn boundary
  const reverse = new State();
  reverse.apply([rotate(32000)], pw);
  reverse.apply([rotate(-32000)], pw, 0.5);
  assert.equal(reverse.rotate, -2048);
  const la2 = new State();
  la2.apply([rotate(32000)], {});
  assert.equal(la2.rotate, 32000);
});

function track({ commands = [], block = -1, length = 20 } = {}) {
  const types = [], durations = [], blocks = [], cmds = new Map();
  for (const command of commands) {
    types.push(1); durations.push(0); blocks.push(-1);
    cmds.set(types.length - 1, [command]);
  }
  if (block >= 0) { types.push(7); durations.push(0); blocks.push(block); }
  types.push(4, 0); durations.push(length, 0); blocks.push(-1, -1);
  return { n: types.length, type: Uint8Array.from(types), dur: Int32Array.from(durations),
    block: Int32Array.from(blocks), delta: new Int32Array(types.length), cmds };
}

function actionFixture({ action = 0x0200BBBB, object = 0xA3, callback = false, duplicate = false } = {}) {
  const command = callback ? [strcode('StartAction'), 0xBBBB, true] : [strcode('LA3StartAction'), 0];
  const compiled = [[track({ commands: duplicate ? [command, command] : [command] })],
    [track({ block: 1, length: 10 }), track({ block: 2, length: 20 })]];
  const la = {
    la3: { keys: [{ action, object }], objects: [{ id: 0, hash: 0xA1 }, { id: 1, hash: 0xA2 }, { id: 2, hash: 0xA3 }] },
    la3Tracks: [[{ hash: 0x0100AAAA }], [{ hash: 0x0100BBBB }, { hash: 0x0200BBBB }]],
    objects: [{ id: 1, parent: 0 }, { id: 2, parent: 0 }, { id: 3, parent: 0 }], layers: [], nblocks: 0,
    actions: [{ flags: 0, tracks: [{ object: 1 }] }, { flags: 0, tracks: [{ object: 1 }, { object: 2 }] }],
    named: new Map([[0xAAAA, 0], [0xBBBB, 1]]),
    packets: i => [{ name: 'xy', lists: [{ points: [[32 * i, 0]] }] }],
  };
  class TestTimeline extends Timeline { tracks(i) { return compiled[i]; } }
  const tl = new TestTimeline(la, 0, 'once');
  return { la, tl };
}

test('LA3 key5 starts the selected source track on the named target object', () => {
  const { la, tl } = actionFixture();
  assert.equal(tl.runs.length, 2);
  assert.deepEqual(tl.runs[1].trackIndices, [1]);
  assert.equal(tl.runs[1].targetObject, 3);
  assert.equal(tl.runs[1].loop, false);
  const scene = new Scene(la, null);
  scene.setTimeline(tl); scene.seek(5);
  assert.deepEqual(scene.state.get(1).xy, [[[0, 0]]]);
  assert.deepEqual(scene.state.get(2).xy, [[[0, 0]]]);
  assert.deepEqual(scene.state.get(3).xy, [[[64, 0]]]);
});

test('LA3 key5 selects all tracks with a low hash, ignores unknown targets and suppresses duplicates', () => {
  assert.deepEqual(actionFixture({ action: 0xBBBB }).tl.runs[1].trackIndices, [0, 1]);
  assert.equal(actionFixture({ action: 0x0300BBBB }).tl.runs.length, 1);
  assert.equal(actionFixture({ action: 0xCCCC }).tl.runs.length, 1);
  assert.equal(actionFixture({ object: 0xBAD }).tl.runs.length, 1);
  const { tl } = actionFixture({ duplicate: true });
  assert.equal(tl.runs.length, 2);
  assert.equal(tl.events[1].ignored, true);
});

test('LA3 key4 remains a callback even if its number equals an LA2 command hash', () => {
  const { tl } = actionFixture({ callback: true });
  assert.equal(tl.runs.length, 1);
  assert.equal(tl.events[0].signal, true);
  assert.equal(tl.events[0].name, 'Game callback #' + strcode('StartAction').toString(16).padStart(6, '0'));
});

test('converted LA3 callback offsets survive raw-key compilation', () => {
  const w = new Writer(true);
  w.zeros(8).u16(1).u16(16).u32(1).u32(strcode('StartAction')).u32(0xBBBB).u16(0).u16(4);
  const la = { actions: [{ tracks: [{ offset: 0, nkeys: 2 }] }], r: new Reader(w.result(), true), la3Signals: new Set([8]) };
  assert.deepEqual(compileTrack(la, 0, 0).cmds.get(0), [[strcode('StartAction'), 0xBBBB, true]]);
});
