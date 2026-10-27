// App integration with DOM / WebGL stubs: checks the exported PNG / APNG / WebP / video dimensions and that opening
// a file enables the crop controls. Pixel colours are covered separately by tests/render.html.
import assert from 'node:assert/strict';
import { Scene } from '../js/engine/scene.js';
import { Model } from '../js/formats/model.js';

const elements = new Map(), downloads = [], blobs = new Map();
const gl = new Proxy({}, { get(_obj, key) {
  if (/^[A-Z0-9_]+$/.test(key)) return 1;
  if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
  if (key === 'getUniformLocation') return (_p, name) => name;
  if (key === 'getAttribLocation') return () => 0;
  if (key === 'readPixels') return (...args) => args.at(-1).fill(0);
  return () => ({});
} });
class E {
  constructor() {
    this.value = ''; this.style = {}; this.dataset = {}; this.listeners = new Map();
    this.width = 8; this.height = 8; this.checked = false; this.children = [];
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  get ownerDocument() { return document; }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  setAttribute() {} setCustomValidity() {} hasPointerCapture() { return false; } getContext() { return gl; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  appendChild(child) { this.children.push(child); } replaceChildren(...children) { this.children = children; }
  remove() {} showModal() { this.open = true; } close() { this.open = false; }
  click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); }
}
const get = id => { if (!elements.has(id)) elements.set(id, new E()); return elements.get(id); };
globalThis.window = { addEventListener() {} };
globalThis.location = { search: '' };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.document = { body: new E(), defaultView: window, getElementById: get, querySelector: s => get(s.startsWith('#') ? s.slice(1) : s),
  querySelectorAll: () => [], addEventListener() {}, createElement: () => new E() };
const nativeTimer = setTimeout;
globalThis.setTimeout = (fn, ms) => { const timer = nativeTimer(fn, ms); if (ms > 1000) timer.unref(); return timer; };
URL.createObjectURL = blob => { const id = 'blob:' + blobs.size; blobs.set(id, blob); return id; };
URL.revokeObjectURL = () => {};
for (const [id, value] of Object.entries({ scale: '1', frame: '0', action: '0', fps: '30', pmode: 'auto', bg: '#202830' })) get(id).value = value;

await import('../js/app/main.js');
const { S, crop, render } = window.__la2;

// A numeric crop drives the preview canvas and every export path.
S.la = { objects: [], nblocks: 0, layers: [], actions: [{ flags: 0, tracks: [] }], named: new Map() };
S.file = { id: 'fixture.la2', path: 'fixture.la2' };
S.lib = { imageKey() { return null; } };
S.scene = new Scene(S.la, null); S.scene._bounds = { x: 0, y: 0, w: 200, h: 100 };
crop.open(S.file.id);
crop.enabled.checked = true; crop.enabled.onchange();
for (const [k, v] of Object.entries({ x: 10, y: 20, w: 13, h: 7 })) crop.fields[k].value = v;
crop.fields.w.oninput(); render();
assert.equal(get('view').width, 13); assert.equal(get('view').height, 7);
crop.select.onclick(); assert.equal(crop.previewView().w, 200);
get('exportPng').onclick(); assert.equal(crop.selecting, false);
for (const fmt of ['apng', 'webp-lossless', 'av1-444']) { get('exportFmt').value = fmt; await get('exportAnim').onclick(); }
for (const { name, blob } of downloads) {
  const bytes = new DataView(await blob.arrayBuffer());
  assert.equal(bytes.getUint32(16), 13, name); assert.equal(bytes.getUint32(20), 7, name);
}
assert.equal(downloads.length, 4);
console.log('PASS: app preview, Frame PNG, APNG, WebP fallback and video fallback all use the 13 × 7 crop.');

// Opening a file must enable the crop toolbar: calling crop.open by hand above cannot catch a missing connection.
const seed = new Uint8Array(96), header = new DataView(seed.buffer);
header.setUint32(0, 0x10008); header.setUint32(4, 52);
const model = new Model(seed); model.addObject(2, { x: 0, y: 0, w: 200, h: 100 });
const file = { id: 'open-crop.la2', path: 'open-crop.la2' };
S.tab = 'file'; S.dir = null; S.files = [file];
S.lib = { la2Bytes: async () => model.build(), prepare: async () => {}, lookup: () => null, imageKey: () => null };
crop.close();
assert.equal(get('cropEnabled').disabled, true); assert.equal(get('cropSelect').disabled, true);
await window.__la2.openFile(file);
assert.equal(crop.file, file.id);
assert.equal(get('cropEnabled').disabled, false); assert.equal(get('cropSelect').disabled, false); assert.equal(get('cropReset').disabled, false);
get('cropSelect').onclick(); assert.equal(crop.selecting, true);
crop.cancel();
console.log('PASS: opening a parsed LA2 enables Crop, Select area and Reset, and selection starts.');
