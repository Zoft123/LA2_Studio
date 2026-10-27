import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackMode, exportSchedule } from '../js/engine/playback.js';
import { Scene, Timeline, State } from '../js/engine/scene.js';
import { Renderer } from '../js/engine/gl.js';
import { VideoWriter, APNGWriter, cropDelta } from '../js/engine/export.js';
import { unzlibSync } from '../js/vendor/fflate.js';
import { Muxer, ArrayBufferTarget } from '../js/vendor/webm-muxer.js';

// A looping track sets x=0, moves to x=160, then holds its final position.
const track = {
  n: 4, type: Uint8Array.of(7, 8, 4, 0), dur: Int32Array.of(0, 10, 1, 0),
  block: Int32Array.of(0, 1, -1, -1), delta: Int32Array.of(0, 0, 0, 0), cmds: new Map(),
};
class FixtureTimeline extends Timeline { tracks() { return [track]; } }
const layout = {
  objects: [{ id: 0, parent: 65535 }], nblocks: 1, layers: [], named: new Map(),
  actions: [{ flags: 1, tracks: [{ object: 0 }] }],
  packets(i) { return [{ name: 'xy', lists: [{ points: [[i ? 160 : 0, 0]] }] }]; },
};

test('freeze retains the terminal pose for auto, loop, once and ping-pong', () => {
  for (const mode of ['auto', 'loop', 'once', 'pingpong']) {
    const timeline = new FixtureTimeline(layout, 0, playbackMode(mode, true));
    const scene = new Scene(layout, null);
    scene.setTimeline(timeline);
    scene.seek(timeline.length());
    assert.equal(timeline.runs[0].loop, false, mode);
    assert.equal(scene.state.get(0).xy[0][0][0], 160, mode);
  }
});

test('turning freeze off restores the selected timeline behavior', () => {
  for (const mode of ['auto', 'loop', 'once', 'pingpong']) {
    assert.equal(playbackMode(mode, false), mode);
  }
  const timeline = new FixtureTimeline(layout, 0, playbackMode('auto', false));
  const scene = new Scene(layout, null);
  scene.setTimeline(timeline);
  scene.seek(timeline.length());
  assert.equal(timeline.runs[0].loop, true);
  assert.equal(scene.state.get(0).xy[0][0][0], 0);
});

test('colours are full-range RGB with alpha 0x80 = opaque', () => {
  const st = new State();
  st.rgba.set(0, [255, 154, 69, 128]);                // MGO2's orange: doubling RGB used to turn it khaki
  assert.deepEqual(st.color(), [1, 154 / 255, 69 / 255, 1]);
  st.rgba.set(0, [249, 89, 68, 64]);
  assert.deepEqual(st.color().map(v => Math.round(v * 255)), [249, 89, 68, 128]);
  assert.deepEqual(new State().color(), [1, 1, 1, 1]);  // nothing set: opaque white
});

test('the view grows to cover where the action ends, and returns to the initial view without one', () => {
  const initial = { x: 0, y: 0, w: 100, h: 50 };
  let at = null;
  const scene = { _bounds: initial, bounds() { return this._bounds; }, timeline: { length: () => 30 },
    seek(f) { at = f; }, primitives: () => [{ pts: [[-40, 10], [-20, 30]] }] };
  Scene.prototype.fitTimeline.call(scene);
  assert.equal(at, 30);
  assert.deepEqual(scene.bounds(), { x: -48, y: 0, w: 148, h: 50 });
  scene.timeline = null;
  Scene.prototype.fitTimeline.call(scene);
  assert.deepEqual(scene.bounds(), initial);
});

const samples = timing => Array.from({ length: timing.count }, (_, i) => timing.at(i));
test('high-FPS export keeps regular samples and appends the terminal frame', () => {
  assert.deepEqual(samples(exportSchedule(5, 120)).map(s => s.frame), [0, 2, 4, 5]);
  assert.deepEqual(samples(exportSchedule(1, 180)).map(s => s.frame), [0, 1]);
  assert.deepEqual(samples(exportSchedule(0, 180)).map(s => s.frame), [0]);
  assert.deepEqual(samples(exportSchedule(6, 180)).map(s => s.frame), [0, 3, 6]);
});

test('sampling preserves source duration at every offered FPS, including short tracks', () => {
  for (const fps of [15, 30, 60, 120, 180]) {
    for (const last of [0, 1, 2, 3, 5, 6, 11, 100]) {
      const frames = samples(exportSchedule(last, fps));
      assert.equal(frames[0].frame, 0);
      assert.equal(frames.at(-1).frame, last);
      assert.equal(new Set(frames.map(s => s.frame)).size, frames.length);
      assert.ok(frames.every(s => s.duration > 0));
      assert.ok(Math.abs(frames.reduce((t, s) => t + s.duration, 0) - (last + 1) * 1000 / fps) < 1e-9);
    }
  }
});

test('opaque draws enable opaque shader output and the next blend resets it', () => {
  let opaque, enabled;
  const gl = {
    BLEND: 1, uniform1i(_loc, value) { opaque = value; },
    disable() { enabled = false; }, enable() { enabled = true; },
    blendEquation() {}, blendEquationSeparate() {}, blendFuncSeparate() {},
  };
  const renderer = { gl, loc: { opaque: 'opaque' } };
  for (const mode of ['normal', 'add', 'sub']) {
    Renderer.prototype._blend.call(renderer, 'none');
    assert.equal(opaque, 1);
    assert.equal(enabled, false);
    Renderer.prototype._blend.call(renderer, mode);
    assert.equal(opaque, 0, mode);
    assert.equal(enabled, true, mode);
  }
});

test('pixel export restores normal alpha colors and leaves opaque colors unchanged', () => {
  const gl = { readPixels(_x, _y, _w, _h, _format, _type, out) {
    out.set([32, 64, 96, 128, 64, 128, 191, 255]);
  } };
  const result = Renderer.prototype.pixels.call({ gl, canvas: { width: 2, height: 1 } });
  assert.deepEqual([...result.rgba], [64, 128, 191, 128, 64, 128, 191, 255]);
});

test('video timestamps remain contiguous when the terminal samples are shorter', async () => {
  const originalCanvas = globalThis.OffscreenCanvas, originalFrame = globalThis.VideoFrame;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.w = w; this.h = h; }
    getContext() { return { fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.w * this.h * 4) }) }; }
  };
  globalThis.VideoFrame = class {
    constructor(_source, options) { this.options = options; }
    close() { this.closed = true; }
  };
  try {
    for (const format of ['h264', 'vp9', 'av1-444']) {
      const frames = [], timing = exportSchedule(5, 120);
      const writer = new VideoWriter(format, 'fixture', 2, 2, timing.fps);
      writer.enc = { encode(frame) { frames.push(frame); }, encodeQueueSize: 0 };
      for (const sample of samples(timing)) await writer.add({}, [0, 0, 0], sample.duration);
      assert.deepEqual(frames.map(f => f.options.timestamp), [0, 16667, 33333, 41667], format);
      assert.equal(frames.at(-1).options.timestamp + frames.at(-1).options.duration, 50000, format);
      for (let i = 1; i < frames.length; i++) {
        assert.equal(frames[i].options.timestamp, frames[i - 1].options.timestamp + frames[i - 1].options.duration);
      }
      assert.ok(frames.every(f => f.closed));
    }
  } finally {
    globalThis.OffscreenCanvas = originalCanvas; globalThis.VideoFrame = originalFrame;
  }
});

test('transparent APNG replaces faded/erased pixels rather than blending over old content', async () => {
  const writer = new APNGWriter(2, 1, 1);
  const first = Uint8Array.of(128, 64, 32, 128, 0, 0, 0, 0);
  const last = Uint8Array.of(0, 0, 0, 0, 128, 64, 32, 64);
  await writer.add(first, 10); await writer.add(last, 20);
  const data = new Uint8Array(await writer.finish().arrayBuffer());
  const view = new DataView(data.buffer), decoded = [], controls = [];
  for (let at = 8; at < data.length;) {
    const size = view.getUint32(at), kind = String.fromCharCode(...data.subarray(at + 4, at + 8));
    const payload = data.subarray(at + 8, at + 8 + size);
    if (kind === 'fcTL') controls.push(payload[25]);
    if (kind === 'IDAT' || kind === 'fdAT') decoded.push([...unzlibSync(kind === 'fdAT' ? payload.subarray(4) : payload).subarray(1)]);
    at += 12 + size;
  }
  assert.deepEqual(controls, [0, 0]); // SOURCE replacement, including transparent pixels.
  assert.deepEqual(decoded, [[...first], [...last]]);
});

test('delta frames blend while every changed pixel is opaque, and replace once one is not', () => {
  const prev = Uint8Array.of(0, 0, 0, 0, 9, 9, 9, 255, 1, 2, 3, 255);
  const r = { x: 0, y: 0, w: 3, h: 1 };
  // the transparent pixel is unchanged and the changed one is opaque: blending over the previous frame is exact
  const opaque = cropDelta(prev, Uint8Array.of(0, 0, 0, 0, 7, 7, 7, 255, 1, 2, 3, 255), 3, r, true);
  assert.equal(opaque.blend, true);
  assert.deepEqual([...opaque.px], [0, 0, 0, 0, 7, 7, 7, 255, 0, 0, 0, 0]);
  // a changed pixel fades: blending would leave the old pixel showing through, so the rectangle is replaced
  const fade = Uint8Array.of(0, 0, 0, 0, 7, 7, 7, 255, 1, 2, 3, 128);
  const faded = cropDelta(prev, fade, 3, r, true);
  assert.equal(faded.blend, false);
  assert.deepEqual([...faded.px], [...fade]);
  // no blending requested (lossy WebP) or no previous frame: a plain crop
  assert.deepEqual(cropDelta(prev, fade, 3, { x: 1, y: 0, w: 2, h: 1 }, false), { px: fade.subarray(4), blend: false });
  assert.equal(cropDelta(null, fade, 3, r, true).blend, false);
});

// Parse actual EBML elements rather than searching for byte patterns in encoded data.
function elements(data, start = 0, end = data.length) {
  const out = [];
  for (let at = start; at < end;) {
    let n = 1;
    while (!(data[at] & (1 << (8 - n)))) n++;
    let id = 0;
    for (let i = 0; i < n; i++) id = id * 256 + data[at++];
    n = 1;
    while (!(data[at] & (1 << (8 - n)))) n++;
    let size = data[at++] & ((1 << (8 - n)) - 1);
    for (let i = 1; i < n; i++) size = size * 256 + data[at++];
    assert.ok(at + size <= end, 'EBML element exceeds its parent');
    out.push({ id, data: data.subarray(at, at + size) });
    at += size;
  }
  return out;
}

test('WebM stores terminal frame durations and references for delta frames', () => {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'V_AV1', width: 2, height: 2, frameRate: 60 } });
  const times = [0, 16667, 33333, 41667], durations = [16667, 16666, 8334, 8333];
  const originalChunk = globalThis.EncodedVideoChunk;
  globalThis.EncodedVideoChunk = class {
    constructor(options) { Object.assign(this, options); this.byteLength = 1; }
    copyTo(out) { out[0] = 0; }
  };
  try {
    for (let i = 0; i < times.length; i++) {
      muxer.addVideoChunk(new EncodedVideoChunk({ type: i ? 'delta' : 'key', timestamp: times[i], duration: durations[i] }));
    }
  } finally {
    globalThis.EncodedVideoChunk = originalChunk;
  }
  muxer.finalize();
  const segment = elements(new Uint8Array(target.buffer)).find(e => e.id === 0x18538067);
  const children = elements(segment.data);
  const info = children.find(e => e.id === 0x1549a966);
  const duration = elements(info.data).find(e => e.id === 0x4489).data;
  assert.equal(new DataView(duration.buffer, duration.byteOffset, duration.length).getFloat64(0), 50);
  const groups = children.filter(e => e.id === 0x1f43b675).flatMap(c => elements(c.data)).filter(e => e.id === 0xa0).map(e => elements(e.data));
  assert.equal(groups.length, 4);
  const value = e => [...e.data].reduce((n, byte) => n * 256 + byte, 0);
  assert.deepEqual(groups.map(g => value(g.find(e => e.id === 0x9b))), [16, 17, 8, 9]);
  assert.equal(groups[0].some(e => e.id === 0xfb), false, 'Keyframes must not have a reference');
  assert.deepEqual(groups.slice(1).map(g => {
    const bytes = g.find(e => e.id === 0xfb).data;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getInt32(0);
  }), [-16, -17, -8]);
});
