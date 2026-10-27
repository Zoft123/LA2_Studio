import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRect, viewport, layoutPoint, selectedCrop } from '../js/engine/viewport.js';
import { CropControls } from '../js/app/crop.js';
import { Renderer } from '../js/engine/gl.js';

test('crop validation accepts negative origins and rejects incomplete or empty sizes', () => {
  assert.deepEqual(cropRect({ x: -25, y: 10, w: 1, h: 20 }), { x: -25, y: 10, w: 1, h: 20 });
  for (const rect of [null, { x: NaN, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10, h: -2 }]) {
    assert.equal(cropRect(rect), null);
  }
});

test('a crop changes the viewport without changing layout bounds or crop state', () => {
  const bounds = { x: -8, y: -8, w: 640, h: 480 };
  const crop = { enabled: true, rect: { x: 100, y: 80, w: 160, h: 90 } };
  assert.deepEqual(viewport(bounds, crop), crop.rect);
  const full = viewport(bounds, { ...crop, enabled: false });
  assert.deepEqual(full, bounds);
  full.x = 999;
  assert.equal(bounds.x, -8);
  assert.deepEqual(crop.rect, { x: 100, y: 80, w: 160, h: 90 });
});

test('reverse drags round outward and stay inside the full view', () => {
  const bounds = { x: -10, y: -20, w: 100, h: 80 };
  assert.deepEqual(selectedCrop([51.2, 30.8], [-99, -99], bounds), { x: -10, y: -20, w: 62, h: 51 });
  assert.equal(selectedCrop([0, 0], [0, 20], bounds), null);
  assert.equal(selectedCrop([0, 0], [20, 0], bounds), null);
});

test('pointer mapping respects cropped origins, CSS zoom and small output dimensions', () => {
  assert.deepEqual(layoutPoint(150, 120, { left: 50, top: 80, width: 200, height: 100 },
    { x: -30, y: 40, w: 100, h: 50 }), [20, 60]);
  assert.deepEqual(layoutPoint(51, 81, { left: 50, top: 80, width: 1, height: 1 },
    { x: 10, y: 20, w: 3, h: 1 }), [13, 21]);
});

test('the renderer frames the exact crop even when the output rounds to one pixel', () => {
  let projection;
  const gl = new Proxy({}, { get: (_obj, name) => name === 'uniform4f' ? (...args) => { projection = args.slice(1); } : () => {} });
  const renderer = { gl, canvas: { width: 8, height: 8 }, loc: {}, data: new Float32Array(8) };
  const view = { x: 10, y: 20, w: 3, h: 1 };
  for (const [scale, width, height] of [[0.25, 1, 1], [1, 3, 1], [2, 6, 2]]) {
    Renderer.prototype.draw.call(renderer, [], view, scale, [0, 0, 0, 0], () => null);
    assert.equal(renderer.canvas.width, width);
    assert.equal(renderer.canvas.height, height);
    assert.deepEqual(projection, [10, 20, 2 / 3, 2]);
  }
});

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.disabled = false; this.style = {};
    this.listeners = new Map(); this.capture = new Set(); this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    this.rect = { left: 50, top: 80, width: 400, height: 200 };
  }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  setCustomValidity(message) { this.validationMessage = message; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.capture.add(id); }
  hasPointerCapture(id) { return this.capture.has(id); }
  releasePointerCapture(id) { this.capture.delete(id); }
  emit(type, data = {}) {
    const event = { button: 0, isPrimary: true, pointerId: 1, ...data,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const fn of this.listeners.get(type) || []) { fn(event); if (event.stopped) break; }
    return event;
  }
}
function fixture() {
  const controls = new Map();
  const doc = new Element(); doc.body = new Element(); doc.defaultView = new Element();
  doc.getElementById = id => { if (!controls.has(id)) controls.set(id, new Element()); return controls.get(id); };
  let stopped = 0, redrawn = 0;
  const crop = new CropControls({ document: doc, getBounds: () => ({ x: -20, y: -10, w: 200, h: 100 }),
    stop: () => stopped++, redraw: () => redrawn++ });
  return { crop, doc, controls, stopped: () => stopped, redrawn: () => redrawn };
}

test('numeric crops apply to preview and output, persist per file and reset to full view', () => {
  const { crop } = fixture();
  assert.equal(crop.enabled.disabled, true);
  crop.open('first'); crop.enabled.checked = true; crop.enabled.onchange();
  for (const [k, value] of Object.entries({ x: 15, y: 25, w: 60, h: 40 })) crop.fields[k].value = value;
  crop.fields.w.oninput();
  assert.deepEqual(crop.previewView(), { x: 15, y: 25, w: 60, h: 40 });
  assert.deepEqual(crop.outputView(), crop.previewView());
  crop.open('second');
  assert.equal(crop.state.enabled, false);
  assert.deepEqual(crop.previewView(), { x: -20, y: -10, w: 200, h: 100 });
  crop.open('first');
  assert.deepEqual(crop.outputView(), { x: 15, y: 25, w: 60, h: 40 });
  crop.reset.onclick();
  assert.equal(crop.state.enabled, false);
  assert.equal(crop.previewView().w, 200);
  crop.close();
  assert.equal(crop.select.disabled, true);
});

test('invalid numeric input keeps the last valid crop until corrected', () => {
  const { crop } = fixture(); crop.open('first');
  crop.enabled.checked = true; crop.enabled.onchange();
  const previous = crop.outputView();
  crop.fields.w.value = '0'; crop.fields.w.oninput();
  assert.deepEqual(crop.outputView(), previous);
  assert.ok(crop.fields.w.validationMessage);
  crop.fields.w.value = '25'; crop.fields.w.onchange();
  assert.equal(crop.outputView().w, 25);
  assert.equal(crop.fields.w.validationMessage, '');
});

test('dragging a crop uses the full layout and does not move/select an object', () => {
  const { crop, stopped } = fixture(); crop.open('first');
  crop.state.enabled = true; crop.state.rect = { x: 0, y: 0, w: 40, h: 40 };
  let objectSelections = 0;
  crop.canvas.addEventListener('pointerdown', () => objectSelections++);
  crop.select.onclick();
  assert.equal(stopped(), 1);
  assert.equal(crop.previewView().w, 200);
  crop.canvas.emit('pointerdown', { clientX: 210, clientY: 160 });
  crop.canvas.emit('pointermove', { clientX: 250, clientY: 200 });
  assert.equal(crop.guide.hidden, false);
  assert.equal(crop.guide.style.width, '40px');
  crop.canvas.emit('pointerup', { clientX: 130, clientY: 120 });
  assert.equal(objectSelections, 0);
  assert.equal(crop.selecting, false);
  assert.equal(crop.canvas.hasPointerCapture(1), false);
  assert.equal(crop.guide.hidden, true);
  assert.deepEqual(crop.previewView(), { x: 20, y: 10, w: 40, h: 20 });
  assert.deepEqual(crop.outputView(), crop.previewView());
  crop.canvas.emit('pointerdown', { clientX: 130, clientY: 120 });
  assert.equal(objectSelections, 1);
});

test('Escape cancels a captured crop drag and preserves the previous crop', () => {
  const { crop, doc } = fixture(); crop.open('first');
  crop.state.enabled = true; crop.state.rect = { x: 5, y: 10, w: 40, h: 25 };
  crop.select.onclick();
  crop.canvas.emit('pointerdown', { clientX: 100, clientY: 100 });
  const event = doc.emit('keydown', { key: 'Escape' });
  assert.equal(event.stopped, true);
  assert.equal(crop.selecting, false);
  assert.equal(crop.canvas.hasPointerCapture(1), false);
  assert.deepEqual(crop.previewView(), { x: 5, y: 10, w: 40, h: 25 });
});

test('pointer cancellation and changing layouts discard incomplete selection gestures', () => {
  const { crop } = fixture(); crop.open('first'); crop.select.onclick();
  crop.canvas.emit('pointerdown', { clientX: 100, clientY: 100 });
  crop.canvas.emit('pointercancel');
  assert.equal(crop.drag, null);
  assert.equal(crop.state.enabled, false);
  crop.canvas.emit('pointerdown', { clientX: 100, clientY: 100 });
  crop.open('second');
  assert.equal(crop.selecting, false);
  assert.equal(crop.canvas.hasPointerCapture(1), false);
  assert.equal(crop.state.enabled, false);
});
