import { cropRect, viewport, layoutPoint, selectedCrop } from '../engine/viewport.js';

/** Crop is view state, kept per file for this session; it never edits the LA2. */
export class CropControls {
  constructor({ getBounds, redraw, stop, document: doc = document }) {
    this.bounds = getBounds; this.redraw = redraw; this.stop = stop; this.doc = doc;
    const byId = id => doc.getElementById(id);
    this.canvas = byId('view'); this.guide = byId('cropGuide');
    this.enabled = byId('cropEnabled'); this.select = byId('cropSelect');
    this.reset = byId('cropReset'); this.hint = byId('cropHint');
    this.fields = Object.fromEntries(['x', 'y', 'w', 'h'].map(k => [k, byId('crop' + k.toUpperCase())]));
    this.states = new Map(); this.file = null; this.state = { enabled: false, rect: null };
    this.selecting = false; this.drag = null;
    this.enabled.onchange = () => { this.state.enabled = this.enabled.checked; this.sync(); this.redraw(); };
    for (const field of Object.values(this.fields)) {
      field.oninput = () => this.read();
      field.onchange = () => { if (this.read()) this.sync(); };
    }
    this.select.onclick = () => {
      if (this.selecting) { this.cancel(); return; }
      if (!this.bounds()) return;
      this.stop(); this.selecting = true; this.sync(); this.redraw();
    };
    this.reset.onclick = () => {
      this.state.enabled = false; this.state.rect = cropRect(this.bounds()); this.state.screen = false;
      this.cancel();
    };
    this.canvas.addEventListener('pointerdown', e => {
      if (!this.selecting) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (e.button !== 0 || e.isPrimary === false) return;
      const start = this.point(e);
      this.drag = { start, end: start, pointerId: e.pointerId };
      this.canvas.setPointerCapture(e.pointerId); this.drawGuide();
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!this.selecting) return;
      e.stopImmediatePropagation();
      if (!this.drag || this.drag.pointerId !== e.pointerId) return;
      this.drag.end = this.point(e); this.drawGuide();
    });
    this.canvas.addEventListener('pointerup', e => {
      if (!this.selecting) return;
      e.stopImmediatePropagation();
      if (!this.drag || this.drag.pointerId !== e.pointerId) return;
      const rect = selectedCrop(this.drag.start, this.point(e), this.bounds());
      if (rect) { this.state.rect = rect; this.state.enabled = true; this.state.screen = false; this.cancel(); }
      else { this.release(); this.sync(); }
    });
    const interrupted = e => {
      if (this.drag?.pointerId === e.pointerId) { this.release(); this.sync(); }
    };
    this.canvas.addEventListener('pointercancel', interrupted);
    this.canvas.addEventListener('lostpointercapture', interrupted);
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.selecting) {
        e.preventDefault(); e.stopImmediatePropagation(); this.cancel();
      }
    });
    byId('stage').addEventListener('scroll', () => this.drawGuide());
    doc.defaultView.addEventListener('resize', () => this.drawGuide());
    this.sync();
  }

  /** `screen`: the area the game shows ({x, y, w, h} layout px), cropped to by default; Reset shows everything. */
  open(file, screen = null) {
    this.file = file;
    if (!this.states.has(file)) this.states.set(file, screen ? { enabled: true, rect: cropRect(screen), screen: true } : { enabled: false, rect: cropRect(this.bounds()) });
    this.state = this.states.get(file);
    this.cancel(false);
  }
  close() { this.file = null; this.state = { enabled: false, rect: null }; this.cancel(false); }
  outputView() { return viewport(this.bounds(), this.state); }
  previewView() { return this.selecting ? { ...this.bounds() } : this.outputView(); }
  point(e) { return layoutPoint(e.clientX, e.clientY, this.canvas.getBoundingClientRect(), this.previewView()); }
  release() {
    const id = this.drag?.pointerId;
    this.drag = null; this.guide.hidden = true;
    if (id !== undefined && this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
  }
  cancel(redraw = true) {
    this.selecting = false; this.release(); this.sync();
    if (redraw) this.redraw();
  }
  read() {
    const input = Object.fromEntries(Object.entries(this.fields).map(([k, field]) => [k, field.valueAsNumber]));
    const rect = cropRect(input);
    for (const [k, field] of Object.entries(this.fields)) {
      const valid = Number.isFinite(input[k]) && (!['w', 'h'].includes(k) || Math.round(input[k]) > 0);
      field.setCustomValidity(valid ? '' : 'Enter a valid coordinate or a positive size.');
    }
    if (!rect) { this.hint.textContent = 'Enter valid coordinates and positive dimensions.'; return false; }
    this.state.rect = rect; this.state.screen = false; this.hint.textContent = `${rect.w} × ${rect.h} layout px · preview + exports`;
    this.redraw(); return true;
  }
  sync() {
    const active = this.file !== null && !!this.bounds();
    const rect = this.state.rect || cropRect(this.bounds()) || { x: 0, y: 0, w: 64, h: 64 };
    this.enabled.checked = this.state.enabled;
    this.enabled.disabled = !active || this.selecting;
    this.select.disabled = this.reset.disabled = !active;
    this.select.textContent = this.selecting ? 'Cancel crop' : 'Select area';
    this.select.setAttribute('aria-pressed', String(this.selecting));
    this.doc.body.classList.toggle('cropmode', this.selecting);
    for (const [k, field] of Object.entries(this.fields)) {
      field.value = rect[k]; field.setCustomValidity('');
      field.disabled = !active || !this.state.enabled || this.selecting;
    }
    this.hint.textContent = this.selecting ? 'Drag an area on the full layout. Esc cancels.' :
      this.state.enabled ? `${rect.w} × ${rect.h} layout px${this.state.screen ? ' (the game screen)' : ''} · preview + exports` : 'Preview + exports';
  }
  drawGuide() {
    if (!this.drag) { this.guide.hidden = true; return; }
    const view = this.bounds(), rect = selectedCrop(this.drag.start, this.drag.end, view);
    this.guide.hidden = !rect;
    if (!rect) return;
    const canvas = this.canvas.getBoundingClientRect();
    Object.assign(this.guide.style, {
      left: `${canvas.left + (rect.x - view.x) * canvas.width / view.w}px`,
      top: `${canvas.top + (rect.y - view.y) * canvas.height / view.h}px`,
      width: `${rect.w * canvas.width / view.w}px`, height: `${rect.h * canvas.height / view.h}px`,
    });
  }
}
