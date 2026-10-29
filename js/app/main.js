// LA2 Studio: browser UI.
import { FileListFS, HandleFS, HttpFS, Library, dirname, basename, ext } from './library.js';
import { LA2, OBJ_TYPES, PACKETS, SECTION_NAMES, OBJ_DEF_NAMES, statusFields, patch } from '../formats/la2.js';
import { Model } from '../formats/model.js';
import { readDar, writeDar } from '../formats/archives.js';
import { encrypt } from '../formats/mgo2crypt.js';
import { Scene, Timeline, COMMANDS, TICKS_PER_SECOND } from '../engine/scene.js';
import { Renderer } from '../engine/gl.js';
import { CropControls } from './crop.js';
import { layoutPoint } from '../engine/viewport.js';
import { playbackMode, exportSchedule } from '../engine/playback.js';
import { WebPWriter, APNGWriter, VideoWriter, VIDEO_FORMATS, videoFormats, encodePNG, webpSupported } from '../engine/export.js';
import { hex, toHex, fromHex, latin1, Reader } from '../core/bin.js';
import { replaceTexture } from './texedit.js';
import { zipSync } from '../vendor/fflate.js';
import * as session from './session.js';
import { WeaponSelect, isWeaponSelect, defaultConfig, parseList, ROWS, CHARACTERS, ICON_NAMES, UNIQUE_OWNER } from './weaponselect.js';

const $ = s => document.querySelector(s);
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- state --------------------------------------------------------------------------------------------------
const S = {
  lib: null, dir: null, files: [], file: null,
  la: null, bytes: null, scene: null, timeline: null,
  also: [],                // actions played alongside the selected one (looping)
  sel: null, tab: 'objects', expanded: new Set(), hideObj: new Set(), hideLayer: new Set(),
  textFocus: null, textFilter: '',  // Text tab: the string being edited ({i, caret}) and the filter
  glyphFont: 0, glyphsOpen: false,  // Text tab: font shown in the character palette, palette open
  edits: new Map(),        // file id -> {bytes, undo: [], redo: []}
  texEdits: new Map(),     // dlz path -> edited DLD bytes
  playing: false, gen: 0,
  ws: null,                // WeaponSelect composition when the open file is the Weapon Select screen
};
const wsCfg = (() => {
  try { return { ...defaultConfig(), ...JSON.parse(localStorage.getItem('la2studio.weaponselect') || '{}') }; } catch (e) { return defaultConfig(); }
})();
const saveWsCfg = () => { try { localStorage.setItem('la2studio.weaponselect', JSON.stringify(wsCfg)); } catch (e) { /* storage unavailable */ } };
const settings = { key: '', ...(() => { try { return JSON.parse(localStorage.getItem('la2studio.settings') || '{}'); } catch (e) { return {}; } })() };
const saveSettings = () => { try { localStorage.setItem('la2studio.settings', JSON.stringify(settings)); } catch (e) { /* storage unavailable */ } };

let renderer;
try { renderer = new Renderer($('#view')); } catch (e) { setTimeout(() => msg('WebGL2 is required: ' + e.message, true), 0); }
// registered before the view's own pointer handlers so a crop drag never selects or moves objects
const cropControls = new CropControls({ getBounds: () => S.scene?.bounds() || null, redraw: () => render(), stop: () => stop() });

// ---- messages / busy ------------------------------------------------------------------------------------------
let msgT = 0;
function msg(t, err = false) {
  const m = $('#msg');
  m.textContent = t; m.title = t; m.classList.toggle('err', err);
  clearTimeout(msgT);
  msgT = setTimeout(() => { m.textContent = ''; }, err ? 9000 : 4500);
}
let busyN = 0;
function busy(d, label = '') { busyN = Math.max(0, busyN + d); $('#busy').textContent = busyN ? label || 'working…' : ''; }
window.addEventListener('unhandledrejection', e => { msg('Error: ' + (e.reason?.message || e.reason), true); console.error(e.reason); });

// ---- opening folders ------------------------------------------------------------------------------------------
$('#openDir').onclick = async () => {
  if (window.showDirectoryPicker) {
    try { await openFS(new HandleFS(await window.showDirectoryPicker({ mode: 'read' }))); }
    catch (e) { if (e.name !== 'AbortError') msg('Could not open the folder: ' + e.message, true); }
  } else $('#dirInput').click();
};
$('#dirInput').onchange = () => { if ($('#dirInput').files.length) openFS(new FileListFS($('#dirInput').files)); };
if (!window.showDirectoryPicker) $('#openDirAlt').style.display = 'none';

async function openFS(fs) {
  if (S.edits.size && !confirm('Opening another folder discards unsaved edits. Continue?')) return;
  S.edits.clear(); S.texEdits.clear(); updateSaveButtons();
  busy(1, 'reading folder…');
  try {
    const lib = new Library(fs, settings);
    const n = await lib.scan(k => { $('#busy').textContent = `reading folder… ${k} files`; });
    S.lib = lib; S.dir = null; S.files = []; closeFile();
    await restoreSession(fs.name);
    $('#info').textContent = `${fs.name} · ${n} files`;
    S.expanded = new Set([fs.name]);
    drawTree();
    // open the first folder with LA2 data
    const first = [...lib.dirs.keys()].sort().find(d => lib.dirs.get(d).files.some(p => ['.la2', '.dar'].includes(ext(p))));
    if (first) { let d = first; while (d.includes('/')) { S.expanded.add(d); d = dirname(d); } drawTree(); await selectFolder(first); }
    else msg('No .la2 or .dar files in this folder', true);
  } finally { busy(-1); }
}

// ---- folder tree ------------------------------------------------------------------------------------------------
function treeCounts() {
  const lib = S.lib, totals = new Map();
  const dirs = [...lib.dirs.keys()].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    let t = lib.dirs.get(d).files.filter(p => ['.la2', '.dar'].includes(ext(p))).length;
    for (const s of lib.dirs.get(d).subdirs) t += totals.get(s) || 0;
    totals.set(d, t);
  }
  return totals;
}
function drawTree() {
  const lib = S.lib;
  if (!lib) return;
  const totals = treeCounts(), out = [];
  const roots = [...lib.dirs.keys()].filter(d => !d.includes('/'));
  const walk = (d, depth) => {
    if (!totals.get(d)) return;
    const e = lib.dirs.get(d), subs = [...e.subdirs].filter(s => totals.get(s)).sort();
    const own = e.files.filter(p => ['.la2', '.dar'].includes(ext(p))).length;
    const open = S.expanded.has(d);
    out.push(`<div class="node${d === S.dir ? ' sel' : ''}" data-d="${esc(d)}" style="padding-left:${8 + depth * 13}px" title="${esc(d)}">` +
      `<span class="tw" data-tw="${esc(d)}">${subs.length ? (open ? '▾' : '▸') : ''}</span>${esc(basename(d))}` +
      `${own ? `<span class="count">${own}</span>` : ''}</div>`);
    if (open) for (const s of subs) walk(s, depth + 1);
  };
  for (const r of roots.sort()) walk(r, 0);
  $('#tree').innerHTML = out.join('') || '<div class="empty">No LA2 data found.</div>';
}
$('#tree').onclick = e => {
  const tw = e.target.closest('[data-tw]');
  const n = e.target.closest('[data-d]');
  if (!n) return;
  const d = n.dataset.d;
  if (tw && tw.textContent) { S.expanded.has(d) ? S.expanded.delete(d) : S.expanded.add(d); drawTree(); return; }
  S.expanded.add(d);
  selectFolder(d);
};
$('#recursive').onchange = () => S.dir && selectFolder(S.dir);

async function selectFolder(d) {
  S.dir = d;
  drawTree();
  const g = ++S.gen;
  busy(1, 'listing LA2 files…');
  try {
    const files = await S.lib.la2Files(d, $('#recursive').checked, (i, n, p) => { $('#busy').textContent = `reading archives ${i + 1}/${n}: ${basename(p)}`; });
    if (g !== S.gen) return;
    S.files = files;
    drawFiles();
    $('#busy').textContent = 'indexing textures…';
    await S.lib.openTextures(d, (i, n, p) => { $('#busy').textContent = `indexing textures ${i + 1}/${n}: ${basename(p)}`; });
    S.lib.resetResolved();
    if (files.length === 1) openFile(files[0]);
  } finally { busy(-1); }
}

let filterT = 0;
$('#filter').oninput = () => { clearTimeout(filterT); filterT = setTimeout(drawFiles, 120); };
function drawFiles() {
  const words = $('#filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = S.files.filter(f => words.every(w => f.id.toLowerCase().includes(w)));
  const shown = list.slice(0, 2000);
  $('#files').innerHTML = shown.map((f, i) => `<div class="file${S.file && f.id === S.file.id ? ' sel' : ''}" data-i="${S.files.indexOf(f)}" title="${esc(f.id)}">${S.edits.has(f.id) ? '● ' : ''}${esc(f.id)}</div>`).join('')
    || `<div class="empty">${S.dir ? 'No LA2 files here. Tick “subfolders” or pick another folder.' : ''}</div>`;
  $('#fcount').textContent = S.dir ? `${list.length} LA2 files${list.length > shown.length ? ` (first ${shown.length} shown)` : ''}` : '';
}
$('#files').onclick = e => { const d = e.target.closest('[data-i]'); if (d) openFile(S.files[+d.dataset.i]); };

// ---- opening a file ------------------------------------------------------------------------------------------
function closeFile() {
  S.file = null; S.la = null; S.scene = null; S.timeline = null; S.sel = null; stop();
  cropControls.close();
  $('#view').classList.remove('on'); $('#stageEmpty').hidden = false;
  $('#panel').innerHTML = ''; $('#action').innerHTML = '<option value="-1">Initial state</option>'; $('#events').hidden = true;
}

async function openFile(f, keep = null) {
  const g = ++S.gen;
  stop();
  busy(1, 'opening ' + basename(f.id) + '…');
  try {
    let ed = S.edits.get(f.id);
    if (ed && ed.restored) {             // restored from an earlier session: only if it is still the same file
      const orig = await S.lib.la2Bytes(f);
      if (session.fingerprint(orig) === ed.fp) { ed.orig = orig; ed.restored = false; }
      else { S.edits.delete(f.id); ed = null; msg(`The kept edit of ${f.id} belongs to a different file and was dropped`, true); }
    }
    const bytes = ed ? ed.bytes : await S.lib.la2Bytes(f);
    if (g !== S.gen) return;
    const la = new LA2(bytes);
    $('#busy').textContent = 'loading textures…';
    await S.lib.prepare(la.tex_tbl.map(([h]) => h), S.texEdits);
    if (g !== S.gen) return;
    S.file = f; S.bytes = bytes; S.la = la;
    S.scene = new Scene(la, S.lib);
    S.ws = null;
    if (isWeaponSelect(la)) {
      $('#busy').textContent = 'loading weapon icons…';
      S.ws = new WeaponSelect(S.lib, dirname(f.path), la);
      await S.ws.load(wsCfg, S.texEdits);
      if (g !== S.gen) return;
      S.ws.apply(S.scene, wsCfg);
    }
    $('#tabs [data-t="weapons"]').hidden = !S.ws;
    if (!S.ws && S.tab === 'weapons') S.tab = 'objects';
    if (!keep) { S.sel = null; S.hideObj = new Set(); S.hideLayer = new Set(); }
    S.scene.hidden = S.hideObj; S.scene.hiddenLayers = S.hideLayer; S.scene.showGuides = !!settings.guides;
    cropControls.open(f.id, flashStage(la, f.path));
    const pd = $('#action');
    pd.innerHTML = '<option value="-1">Initial state</option>' + la.actions.map((a, i) => {
      const h = la.actionHash.get(i);
      return `<option value="${i}">Action ${i}${h !== undefined ? ' #' + hex(h) : ''} · ${a.tracks.length} tracks${a.flags ? ' · loops' : ''}</option>`;
    }).join('');
    $('#alsoAdd').innerHTML = '<option value="">+ also play…</option>' + pd.innerHTML.replace(/^<option value="-1">Initial state<\/option>/, '');
    if (keep) { pd.value = keep.action; S.also = S.also.filter(i => i < la.actions.length); S.sel = keep.sel !== null && keep.sel < la.objects.length ? keep.sel : null; S.tab = keep.tab; }
    else { pd.value = '-1'; S.also = gameLayers(la); }
    drawAlso();
    $('#info').textContent = `${f.id} · v${(la.version & 0xFFFF).toString(16)} · ${la.le ? 'PC (LE)' : 'PS3 (BE)'} · ${la.objects.length} objects · ${la.actions.length} actions · ${la.tex_tbl.length} textures${ed ? ' · edited' : ''}`;
    $('#info').title = f.path + (f.entry ? ' :: ' + f.entry : '');
    $('#view').classList.add('on'); $('#stageEmpty').hidden = true;
    loadTimeline();
    if (keep) $('#frame').value = Math.min(+$('#frame').max, keep.frame);
    drawFiles(); render(); showTab(); updateUndo(); updateSaveButtons();
    const missing = la.tex_tbl.filter(([h]) => !S.lib.lookup(h)).length;
    if (missing) msg(`${missing} of ${la.tex_tbl.length} textures not found in this folder (Textures tab → search everything)`, false);
  } catch (e) {
    msg('Could not open ' + f.id + ': ' + e.message, true);
    console.error(e);
  } finally { busy(-1); }
}

// ---- timeline / playback ---------------------------------------------------------------------------------------
function loadTimeline() {
  const a = +$('#action').value, ev = $('#events');
  if (!S.la || a < 0) { S.timeline = null; if (S.scene) { S.scene.setTimeline(null); S.scene.fitTimeline(); } $('#frame').max = 0; $('#frame').value = 0; ev.hidden = true; return; }
  S.timeline = new Timeline(S.la, a, currentPlaybackMode(), { also: S.also });
  S.scene.setTimeline(S.timeline);
  S.scene.fitTimeline();
  const tl = S.timeline;
  $('#frame').max = tl.length();
  const label = i => 'action ' + i + (S.la.actionHash.has(i) ? ' #' + hex(S.la.actionHash.get(i)) : '');
  const runs = tl.runs.slice(1).map(r => `<span title="starts at ${r.start}${r.stop !== null ? ', stopped at ' + r.stop : ''}">▶ ${label(r.action)} @${r.start}${r.loop ? ' ⟳' : ''}${r.stop !== null ? ' ■' + r.stop : ''}</span>`);
  const evs = tl.events.filter(e => e.name !== 'Name').slice(0, 300).map(e => {
    const target = S.la.named.get(e.arg);
    return `<span class="ev" data-fr="${e.frame}" title="from ${label(e.action)}${e.ignored ? ' (already playing: the game ignores it)' : ''}">${e.frame}: ${esc(e.name)}${target !== undefined ? ' → ' + label(target) : ' #' + hex(e.arg)}${e.ignored ? ' (ignored)' : ''}</span>`;
  });
  ev.innerHTML = `${tl.runs[0].loop ? '⟳ loops · ' : ''}${tl.length()} ticks (${(tl.length() / TICKS_PER_SECOND).toFixed(2)} s)` + (runs.length ? ' · also plays: ' + runs.join(' ') : '') + (evs.length ? '<br>' + evs.join('') : '');
  ev.hidden = !(runs.length || evs.length || tl.runs[0].loop);
}
$('#events').onclick = e => { const d = e.target.closest('[data-fr]'); if (d) { stop(); $('#frame').value = d.dataset.fr; render(); } };
$('#action').onchange = () => { stop(); $('#frame').value = 0; loadTimeline(); render(); if (S.tab === 'keys') showTab(); };
$('#pmode').onchange = () => { stop(); loadTimeline(); render(); };

// actions the game keeps running under the selected one: the lobby rule screen (rule_anime) loops its soldiers'
// run cycle (#2b7872) and goals (#925b6e) under every rule's action (MGO2 sub_9BF450), so on their own the
// soldiers only appear once they stop running
const GAME_LAYERS = [[0x2b7872, 0x925b6e]];
const gameLayers = la => (GAME_LAYERS.find(hs => hs.every(h => la.named.has(h))) || []).map(h => la.named.get(h));
// MGS4's Flash-converted movies (slotdat/slot_flash) are authored on a 320 × 180 px stage that the game draws
// full screen: they sit in slot_flash folders and most carry a stage-sized Quad / RSprt at the origin (some with a
// few px of overscan). Anything past the stage is off screen, so the view starts cropped to it (Reset shows all).
const STAGE = { x: 0, y: 0, w: 320, h: 180 };
function flashStage(la, path) {
  if (/(^|\/)slot_flash\//i.test(path)) return STAGE;
  for (const o of la.objects) {
    if (o.type !== 4 && o.type !== 6) continue;
    const xy = la.packets(o.index).find(p => p.name === 'xy');
    const pts = xy && xy.lists.length === 1 && xy.lists[0].points;
    if (!pts || pts.length !== 4) continue;
    const xs = pts.map(p => p[0] / 16), ys = pts.map(p => p[1] / 16);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
    if (Math.abs(x0) <= 3 && Math.abs(y0) <= 3 && w >= 316 && w <= 328 && h >= 178 && h <= 186) return STAGE;
  }
  return null;
}
function drawAlso() {
  $('#alsoList').innerHTML = S.also.map(i => {
    const h = S.la.actionHash.get(i);
    return `<span class="chip" title="Plays alongside the selected action, looping">${i}${h !== undefined ? ' #' + hex(h) : ''}<button data-rm="${i}" aria-label="Stop playing action ${i} alongside">×</button></span>`;
  }).join('');
}
const alsoChanged = () => { stop(); drawAlso(); loadTimeline(); render(); };
$('#alsoAdd').onchange = () => {
  const v = $('#alsoAdd').value, i = +v;
  $('#alsoAdd').value = '';
  if (v !== '' && S.la && !S.also.includes(i)) { S.also.push(i); alsoChanged(); }
};
$('#alsoList').onclick = e => {
  const b = e.target.closest('[data-rm]');
  if (b) { S.also = S.also.filter(i => i !== +b.dataset.rm); alsoChanged(); }
};
$('#frame').oninput = () => render();
$('#frameNum').onchange = () => {
  const fr = $('#frame'), v = Math.round(+$('#frameNum').value);
  if (!Number.isFinite(v)) return;
  stop(); fr.value = Math.max(0, Math.min(+fr.max, v)); $('#frameNum').blur(); render();
};
$('#frameNum').onkeydown = e => { if (e.key === 'Enter') $('#frameNum').onchange(); };
$('#scale').onchange = () => render();

// view preferences (freeze, background) persist per browser
const pref = k => { try { return localStorage.getItem('la2studio.' + k); } catch (e) { return null; } };
const setPref = (k, v) => { try { localStorage.setItem('la2studio.' + k, String(v)); } catch (e) { /* storage unavailable */ } };

// freeze on the last frame: plays once, for playback and export
if (pref('freezeEnd') !== null) $('#freezeEnd').checked = pref('freezeEnd') === 'true';
const currentPlaybackMode = () => playbackMode($('#pmode').value, $('#freezeEnd').checked);
const playsOnce = () => currentPlaybackMode() === 'once';
$('#freezeEnd').onchange = () => {
  setPref('freezeEnd', $('#freezeEnd').checked);
  const frame = +$('#frame').value;
  stop(); loadTimeline();
  $('#frame').value = Math.min(frame, +$('#frame').max);
  render();
};

// background: transparent (the default) or a solid colour; video, which has no alpha, always uses the colour
if (pref('bgTransparent') !== null) $('#bgTransparent').checked = pref('bgTransparent') === 'true';
if (pref('bgColor')) $('#bg').value = pref('bgColor');
const isBgTransparent = () => $('#bgTransparent').checked;
const solidBgColor = () => { const h = $('#bg').value; return [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)); };
const bgColor = () => isBgTransparent() ? [0, 0, 0, 0] : [...solidBgColor(), 255];
$('#bgTransparent').onchange = () => { setPref('bgTransparent', isBgTransparent()); render(); };
$('#bg').oninput = () => {
  $('#bgTransparent').checked = false;
  setPref('bgTransparent', false); setPref('bgColor', $('#bg').value);
  render();
};
window.addEventListener('resize', () => { if ($('#scale').value === 'fit') render(); });

function stop() { S.playing = false; $('#play').textContent = '▶'; }
async function play() {
  if (S.playing) { stop(); return; }
  if (!S.timeline || !+$('#frame').max) { msg('Pick an action with frames first'); return; }
  // 'once' stops on the last frame (pressing play there starts over); other modes wrap around
  const fr = $('#frame'), max = +fr.max, once = playsOnce();
  if (once && +fr.value >= max) { fr.value = 0; render(); }
  S.playing = true; $('#play').textContent = '■';
  const g = S.gen, t0 = performance.now(), f0 = +fr.value;
  while (S.playing && g === S.gen) {
    const f = f0 + Math.floor((performance.now() - t0) * +$('#fps').value / 1000);
    const next = once ? Math.min(max, f) : f % (max + 1);
    if (+fr.value !== next) { fr.value = next; render(); }
    if (once && f >= max) { stop(); break; }
    await new Promise(r => requestAnimationFrame(r));
  }
}
$('#play').onclick = play;

// ---- rendering ----------------------------------------------------------------------------------------------------
function scaleNow() {
  const v = $('#scale').value;
  if (v !== 'fit' || !S.scene) return +v || 1;
  const b = cropControls.previewView(), st = $('#stage');
  return Math.max(0.125, Math.floor(Math.min((st.clientWidth - 28) / b.w, (st.clientHeight - 28) / b.h) * 8) / 8);
}
const texSource = h => {
  const key = S.lib.imageKey(h);
  return key ? { key, image: () => S.lib.image(h) } : null;
};
function subtree(id) {
  const ids = new Set([id]);
  for (const o of S.la.objects) if (ids.has(o.parent)) ids.add(o.id);
  return ids;
}
/** Draw the current frame; `withOutline` false leaves the selection outline out (for exports). */
function render(dragOffset = null, withOutline = true) {
  if (!S.scene || !renderer) return;
  const f = +$('#frame').value;
  if (document.activeElement !== $('#frameNum')) $('#frameNum').value = f;
  $('#flabel').textContent = `${(f / TICKS_PER_SECOND).toFixed(2)} s`;
  if (S.timeline) S.scene.seek(f); else S.scene.frame = 0;
  const prims = S.scene.primitives();
  S.lastPrims = prims;
  let outline = null;
  if (withOutline && S.sel !== null && S.la.objects[S.sel]) {
    const ids = subtree(S.la.objects[S.sel].id);
    outline = prims.filter(p => ids.has(p.id)).map(p => p.pts.map(([x, y]) => dragOffset ? [x + dragOffset[0], y + dragOffset[1]] : [x, y]));
  }
  renderer.draw(prims, cropControls.previewView(), scaleNow(), bgColor(), texSource, outline);
  cropControls.drawGuide();
}

// click to select the topmost object under the pointer
function hitTest(px, py) {
  const inside = (pts, x, y) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let i = (S.lastPrims || []).length - 1; i >= 0; i--) {
    const p = S.lastPrims[i];
    if (p.kind === 'fan' && !p.ext && p.pts.length >= 3 && inside(p.pts, px, py)) return p.id;
  }
  return null;
}
function canvasToLayout(e) {
  return layoutPoint(e.clientX, e.clientY, $('#view').getBoundingClientRect(), cropControls.previewView());
}
let drag = null;
$('#view').addEventListener('pointerdown', e => {
  if (!S.scene) return;
  const [x, y] = canvasToLayout(e);
  if ($('#dragmove').checked && S.sel !== null) {
    e.preventDefault(); $('#view').setPointerCapture(e.pointerId);
    drag = { x, y }; $('#view').classList.add('dragging');
    return;
  }
  const id = hitTest(x, y);
  if (id !== null) { S.sel = S.la.objects.findIndex(o => o.id === id); render(); if (S.tab === 'objects' || S.tab === 'props') { S.tab = 'props'; showTab(); } }
});
$('#view').addEventListener('pointermove', e => {
  if (!drag) return;
  const [x, y] = canvasToLayout(e);
  render([x - drag.x, y - drag.y]);
  $('#flabel').textContent = `move ${Math.round(x - drag.x)}, ${Math.round(y - drag.y)} px`;
});
$('#view').addEventListener('pointerup', e => {
  if (!drag) return;
  const [x, y] = canvasToLayout(e), dx = Math.round(x - drag.x), dy = Math.round(y - drag.y);
  drag = null; $('#view').classList.remove('dragging');
  if (dx || dy) moveSel(dx, dy); else render();
});
$('#dragmove').onchange = () => document.body.classList.toggle('dragmode', $('#dragmove').checked);

// ---- editing (every edit rebuilds the file through the model; undo keeps whole-file snapshots) ------------------
function current() { return S.edits.get(S.file.id)?.bytes || S.bytes; }
async function edit(fn, label = 'edited') {
  if (!S.file) return;
  const before = current();
  const m = new Model(before);
  const r = fn(m);
  if (r === false) return;
  const after = m.build();
  new LA2(after);                                          // must still parse
  const e = editEntry();
  e.undo.push(before); if (e.undo.length > 100) e.undo.shift();
  e.redo = []; e.bytes = after;
  S.edits.set(S.file.id, e);
  await reopen();
  msg(label);
  return r;
}
/** The current file's edit record, created on its first edit (with a fingerprint of the original for restores). */
function editEntry() {
  return S.edits.get(S.file.id) || { bytes: null, undo: [], redo: [], orig: S.bytes, fp: session.fingerprint(S.bytes) };
}
async function reopen() {
  await openFile(S.file, { action: $('#action').value, frame: +$('#frame').value, sel: S.sel, tab: S.tab });
}
function updateUndo() {
  const e = S.file && S.edits.get(S.file.id);
  $('#undo').disabled = !e || !e.undo.length; $('#redo').disabled = !e || !e.redo.length;
}
async function undoRedo(redo) {
  const e = S.file && S.edits.get(S.file.id);
  if (!e) return;
  const from = redo ? e.redo : e.undo, to = redo ? e.undo : e.redo;
  if (!from.length) return;
  to.push(e.bytes || e.orig);
  e.bytes = from.pop();
  // back at the original with nothing left to undo or redo: the file counts as unedited again
  if (e.bytes === e.orig && !e.undo.length && !e.redo.length) S.edits.delete(S.file.id);
  await reopen();
  msg(redo ? 'redone' : 'undone');
}
$('#undo').onclick = () => undoRedo(false);
$('#redo').onclick = () => undoRedo(true);
$('#revert').onclick = async () => {
  if (!S.file || !S.edits.has(S.file.id)) return;
  if (!confirm('Discard every edit of this file?')) return;
  S.edits.delete(S.file.id); S.bytes = null;
  await openFile(S.file); msg('edits discarded');
};
async function moveSel(dx, dy) {
  if (S.sel === null) return;
  await edit(m => m.move(S.sel, Math.round(dx * 16), Math.round(dy * 16)) || false, `moved ${dx}, ${dy} px`);
}
window.addEventListener('beforeunload', e => { if (S.edits.size || S.texEdits.size) { e.preventDefault(); e.returnValue = ''; } });

// ---- saving ---------------------------------------------------------------------------------------------------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function updateSaveButtons() {
  $('#saveTex').disabled = !S.texEdits.size;
  $('#revert').disabled = !(S.file && S.edits.has(S.file.id));
  saveSession();
}
// unsaved edits are mirrored to IndexedDB (per opened folder) so a reload or crash does not lose them
let sessionT = 0;
function saveSession() {
  const folder = S.lib?.fs?.name;
  if (!folder) return;
  clearTimeout(sessionT);
  sessionT = setTimeout(() => session.sync(folder, S.edits, S.texEdits), 300);
}
async function restoreSession(folder) {
  const saved = await session.load(folder);
  if (!saved.length) return;
  const files = saved.filter(s => s.kind === 'la2').length, tex = saved.length - files;
  const when = new Date(Math.max(...saved.map(s => s.time))).toLocaleString();
  const what = [files && `${files} layout${files > 1 ? 's' : ''}`, tex && `${tex} texture archive${tex > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
  if (!confirm(`Unsaved edits to ${what} in “${folder}” were kept from ${when}.\n\nRestore them? (Cancel discards them.)`)) { session.clear(folder); return; }
  for (const s of saved) {
    if (s.kind === 'la2') S.edits.set(s.id, { bytes: s.bytes, undo: [], redo: [], orig: null, fp: s.fp, restored: true });
    else S.texEdits.set(s.id, s.bytes);
  }
  updateSaveButtons();
  msg(`restored unsaved edits to ${what}`);
}
$('#saveLa2').onclick = () => { if (S.file) download(new Blob([current()]), basename(S.file.entry || S.file.path)); };
$('#saveDar').onclick = async () => {
  if (!S.file) return;
  const f = S.file, lib = S.lib;
  let darPath = f.entry ? f.path : null, name = f.entry || basename(f.path);
  if (!darPath) {           // a loose LA2 (extracted layout): the .dar up to three folders above that holds it
    let d = dirname(f.path);
    outer: for (let k = 0; k < 4; k++) {
      d = dirname(d);
      for (const p of (lib.dirs.get(d)?.files || []).filter(p => ext(p) === '.dar')) {
        try { if (readDar(await lib.read(p)).entries.some(e => e.name === name)) { darPath = p; break outer; } } catch (e) { /* skip */ }
      }
    }
  }
  if (!darPath) { msg('No .dar holding ' + name + ' was found', true); return; }
  busy(1, 'building archive…');
  try {
    const data = await lib.read(darPath), dar = readDar(data);
    const files = dar.entries.map(e => ({ name: e.name, data: e.name === name ? current() : data.subarray(e.offset, e.offset + e.size) }));
    let out = writeDar(files, dar.le, data.subarray(dar.end));
    const key = lib.encrypted.get(darPath);
    if (key) out = encrypt(out, key);
    download(new Blob([out]), basename(darPath));
    msg(`saved ${basename(darPath)}${key ? ' (re-encrypted, ' + key + ')' : ''}`);
  } finally { busy(-1); }
};
$('#saveTex').onclick = async () => {
  if (!S.texEdits.size) return;
  busy(1, 'packing textures…');
  try {
    const { buildDlz } = await import('../formats/archives.js');
    const files = {};
    for (const [path, dld] of S.texEdits) {
      const orig = await S.lib.fs.read(path);
      const le = !(orig[0] === 0x73 && orig[1] === 0x65 && orig[2] === 0x67 && orig[3] === 0x73);
      let out = buildDlz(dld, le);
      const key = S.lib.encrypted.get(path);
      if (key) out = encrypt(out, key);
      files[path] = out;
    }
    const names = Object.keys(files);
    if (names.length === 1) download(new Blob([files[names[0]]]), basename(names[0]));
    else download(new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), 'textures.zip');
    msg('saved ' + names.length + ' texture archive(s)');
  } finally { busy(-1); }
};

// ---- export ---------------------------------------------------------------------------------------------------
$('#exportPng').onclick = () => {
  if (!S.scene) return;
  cropControls.cancel(false);
  render(null, false);
  const px = renderer.pixels();
  render();
  download(encodePNG(px.w, px.h, px.rgba), basename(S.file.entry || S.file.path).replace(/\.la2$/i, '') + `_${$('#action').value}_${$('#frame').value}.png`);
};
let exportCancel = false;
$('#exportCancel').onclick = () => { exportCancel = true; };
$('#exportAnim').onclick = async () => {
  if (!S.scene) return;
  cropControls.cancel();
  const a = +$('#action').value;
  if (a < 0) { msg('Pick an action first'); return; }
  let fmt = $('#exportFmt').value;
  const video = !!VIDEO_FORMATS[fmt];
  const baseName = basename(S.file.entry || S.file.path).replace(/\.la2$/i, '') + `_action${a}`;
  // long videos stream straight to disk where the browser allows it (asked first: it needs the click)
  let fileHandle = null;
  if (video && window.showSaveFilePicker) {
    const f = VIDEO_FORMATS[fmt];
    try { fileHandle = await window.showSaveFilePicker({ suggestedName: `${baseName}.${f.ext}`, types: [{ description: f.label, accept: { [f.mime]: ['.' + f.ext] } }] }); }
    catch (e) { if (e.name === 'AbortError') return; fileHandle = null; }
  }
  stop();
  const dlg = $('#exportDlg'), status = $('#exportStatus'), prog = $('#exportProg');
  exportCancel = false; dlg.showModal();
  const t0 = performance.now();
  let writer = null;
  try {
    // a private scene, timeline and GL context so the preview is untouched
    const scene = new Scene(S.la, S.lib);
    scene.hidden = S.hideObj; scene.hiddenLayers = S.hideLayer; scene.showGuides = !!settings.guides;
    if (S.ws) S.ws.apply(scene, wsCfg);
    const tl = new Timeline(S.la, a, currentPlaybackMode(), { also: S.also });
    scene.setTimeline(tl);
    const canvas = document.createElement('canvas');
    const r = new Renderer(canvas);
    const timing = exportSchedule(tl.length(), +$('#fps').value);
    const frames = timing.count;
    const scale = scaleNow(), view = cropControls.outputView(), bg = bgColor();
    const W = Math.max(1, Math.round(view.w * scale)), H = Math.max(1, Math.round(view.h * scale));
    let kind = video ? 'video' : fmt.startsWith('webp') ? 'webp' : 'apng';
    if (video) {
      const ok = await videoFormats(W + (W & 1), H + (H & 1));
      if (!ok[fmt]) {
        const alt = Object.keys(VIDEO_FORMATS).find(k => ok[k]);
        if (!alt) { msg('This browser cannot encode video; exporting APNG instead'); kind = 'apng'; }
        else { msg(`${VIDEO_FORMATS[fmt].label} is not available here; using ${VIDEO_FORMATS[alt].label}`); fmt = alt; }
      }
      if (kind === 'video') { writer = new VideoWriter(fmt, ok[fmt], W, H, timing.fps); await writer.open(fileHandle); }
    }
    if (kind === 'webp' && !(await webpSupported())) { msg('This browser cannot encode WebP; exporting APNG instead'); kind = 'apng'; }
    const q = fmt === 'webp-lossless' ? 1 : +(fmt.split('-')[1] || 90) / 100;
    const loop = playsOnce() ? 1 : 0;
    let distinct = 0;
    for (let i = 0; i < frames; i++) {
      if (exportCancel) { if (writer && writer.abort) await writer.abort(); msg('export cancelled'); return; }
      const { frame: f, duration: dur } = timing.at(i);
      scene.seek(f);
      r.draw(scene.primitives(), view, scale, bg, texSource);
      if (kind === 'video') { await writer.add(canvas, solidBgColor(), dur); distinct++; }
      else {
        const px = r.pixels();
        if (!writer) writer = kind === 'webp' ? new WebPWriter(px.w, px.h, q, loop) : new APNGWriter(px.w, px.h, loop);
        if (await writer.add(px.rgba, dur)) distinct++;
      }
      if (i % 4 === 0) {
        const el = (performance.now() - t0) / 1000, eta = el / (i + 1) * (frames - i - 1);
        status.textContent = `Frame ${i + 1} / ${frames} · ${el.toFixed(0)} s elapsed · about ${eta < 90 ? eta.toFixed(0) + ' s' : (eta / 60).toFixed(0) + ' min'} left`;
        prog.value = (i + 1) / frames;
        await sleep(0);
      }
    }
    status.textContent = 'Finishing…';
    await sleep(0);
    const blob = kind === 'video' ? await writer.finish() : writer.finish();
    const ext = kind === 'video' ? VIDEO_FORMATS[fmt].ext : kind === 'webp' ? 'webp' : 'png';
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (blob) download(blob, `${baseName}.${ext}`);
    const size = blob ? blob.size : null;
    msg(`exported ${baseName}.${ext}${size !== null ? ` (${(size / 1048576).toFixed(1)} MB)` : ' to the chosen file'} · ${frames} frames · ${secs} s`);
    r.dropTextures();
  } catch (e) { msg('Export failed: ' + e.message, true); console.error(e); if (writer && writer.abort) await writer.abort(); }
  finally { dlg.close(); }
};

// ---- settings ------------------------------------------------------------------------------------------------
$('#settingsBtn').onclick = () => { $('#keyOverride').value = settings.key || ''; $('#showGuides').checked = !!settings.guides; $('#settings').showModal(); };
$('#settings').addEventListener('close', () => {
  settings.key = $('#keyOverride').value.trim();
  if (settings.key && !settings.key.startsWith('stage/')) settings.key = 'stage/' + settings.key;
  settings.guides = $('#showGuides').checked;
  saveSettings();
  if (S.lib) { S.lib.settings = settings; S.lib.raw.clear(); }
  if (S.scene) { S.scene.showGuides = settings.guides; render(); }
});

// ---- keyboard ---------------------------------------------------------------------------------------------------
document.addEventListener('keydown', e => {
  const el = e.target instanceof Element ? e.target : document.body;
  const typing = el.matches('input:not([type=range]):not([type=checkbox]), textarea, select');
  if ((e.ctrlKey || e.metaKey) && !typing) {
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo(false); return; }
    if (e.key === 'y' || (e.key === 'Z' && e.shiftKey)) { e.preventDefault(); undoRedo(true); return; }
  }
  if (typing || el.matches('button')) return;
  const fr = $('#frame');
  if (e.shiftKey && S.sel !== null && e.key.startsWith('Arrow')) {
    const s = e.ctrlKey ? 10 : 1, d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
    e.preventDefault(); moveSel(...d); return;
  }
  if (e.key === ' ') { e.preventDefault(); play(); }
  else if (e.key === 'ArrowRight' || e.key === '.') { stop(); fr.value = Math.min(+fr.max, +fr.value + 1); render(); }
  else if (e.key === 'ArrowLeft' || e.key === ',') { stop(); fr.value = Math.max(0, +fr.value - 1); render(); }
  else if (e.key === '/') { e.preventDefault(); $('#filter').focus(); }
  else if (e.key === 'o') { e.preventDefault(); $('#openDir').click(); }
  else if (e.key === 'Escape' && S.sel !== null) { S.sel = null; render(); showTab(); }
});

// ---- tabs ---------------------------------------------------------------------------------------------------------
$('#tabs').onclick = e => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  S.tab = b.dataset.t;
  showTab();
};
function showTab() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === S.tab));
  const P = $('#panel');
  if (!S.la) { P.innerHTML = '<div class="pad dim">Open a file to inspect it.</div>'; return; }
  ({ objects: tabObjects, props: tabProps, text: tabText, textures: tabTextures, tables: tabTables, keys: tabKeys, file: tabFile, weapons: tabWeapons })[S.tab](P);
}
const OBJ_TYPE_LABELS = { 0: 'Nul (group)', 2: 'Box', 3: 'Sprt (sprite)', 4: 'RSprt (4-point sprite)', 5: 'Triangle', 6: 'Quad',
  7: 'Line', 8: 'LineStrip', 9: 'TriangleStrip', 10: 'String' };
function addForm(parentIndex) {
  return `<div class="section"><h3>Add object</h3><div class="dim small">${parentIndex === null ? 'At the root' : 'As a child of this object'}; position in the parent's space (px).</div>
    <div class="addrow"><select id="addtype">${Object.entries(OBJ_TYPE_LABELS).map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>
    x <input id="addx" value="0"> y <input id="addy" value="0"> w <input id="addw" value="64"> h <input id="addh" value="48">
    text <input id="addtext" value="TEXT" style="width:80px"> <button id="addbtn">Add</button></div></div>`;
}
function bindAdd(parentIndex) {
  $('#addbtn').onclick = async () => {
    const la = S.la, typ = +$('#addtype').value, opts = {
      parent: parentIndex === null ? 0 : la.objects[parentIndex].id,
      x: Math.round(+$('#addx').value * 16), y: Math.round(+$('#addy').value * 16),
      w: Math.round(+$('#addw').value * 16), h: Math.round(+$('#addh').value * 16), text: $('#addtext').value };
    if (typ === 10) {           // a String copies its texture and layout from the first String in the file
      const src = la.objects.find(o => o.type === 10);
      if (src) for (const p of la.packets(src.index)) { if (p.name === 'texture') opts.texture = p.value; if (p.name === 'text_layout') opts.textLayout = p.values; }
    }
    const idx = await edit(m => m.addObject(typ, opts), 'added ' + OBJ_TYPES[typ]);
    if (idx !== undefined) { S.sel = idx; S.tab = 'props'; render(); showTab(); }
  };
}

// ---- Weapon Select composition ----------------------------------------------------------------------------------
async function updateWeapons() {
  if (!S.ws) return;
  saveWsCfg();
  busy(1, 'loading weapon icons…');
  try { await S.ws.load(wsCfg, S.texEdits); S.ws.apply(S.scene, wsCfg); render(); }
  finally { busy(-1); }
  if (S.tab === 'weapons') showTab();
}
const weaponName = id => (ICON_NAMES[id] || '').replace(/^(wp|sp)icon_(b_)?/, '') || (id ? '#' + id : 'none');
function tabWeapons(P) {
  const rows = S.ws.rows(wsCfg);
  const missing = [...S.ws.missing];
  P.innerHTML = `<div class="pad">
    <div class="dim small">The game fills this screen at runtime: each weapon is its own <code>wpicon_*.la2</code> layout,
      placed in the row cells the way MGO2 does it. The lists use the stage script's format
      (<code>[d7cbe5] -group N -wp_id &lt;id&gt; &lt;cost&gt; …</code>): paste a <code>-wp_id</code> list or a whole command.</div>
    <div class="addrow"><label><input type="checkbox" id="wsOn" ${wsCfg.enabled ? 'checked' : ''}> show weapons</label>
      <label>character <select id="wsChar">${CHARACTERS.map(([v, n]) => `<option value="${v}" ${wsCfg.character === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
    <div class="addrow"><label><input type="checkbox" id="wsDp" ${wsCfg.drebin ? 'checked' : ''}> Drebin Points mode</label>
      <label>budget <input id="wsBudget" value="${wsCfg.budget}" style="width:70px"></label>
      <label>cost × <input id="wsMult" value="${wsCfg.mult}" style="width:50px"></label></div>
    ${missing.length ? `<div class="warn small">icon layouts not found in this folder or its dl/p twin: ${missing.map(esc).join(', ')}</div>` : ''}
  </div>` + ROWS.map((r, i) => {
    const list = rows[i], at = wsCfg.scroll[i] || 0, max = Math.max(0, list.length - 6);
    const shown = list.slice(at, at + 6).map(([id, c]) => `${esc(weaponName(id))}${UNIQUE_OWNER.has(id) ? '*' : ''} (${c})`).join(' · ');
    return `<div class="section"><h3>${r.name} <span class="dim small">${list.length} weapons</span></h3>
      <textarea data-wsl="${i}" rows="3" style="width:100%" spellcheck="false">${esc(wsCfg.lists[i])}</textarea>
      <div class="addrow">scroll <input type="range" data-wss="${i}" min="0" max="${max}" value="${Math.min(at, max)}" ${max ? '' : 'disabled'}>
        <span class="dim small">${at + 1}–${Math.min(list.length, at + 6)} of ${list.length}</span></div>
      <div class="dim small">${shown || 'empty'}</div></div>`;
  }).join('') + `<div class="pad"><button id="wsReset">Reset to the stage scripts' default lists</button>
    <div class="dim small">* unique weapons: the game keeps them only for their character (Meryl, Johnny, …).</div></div>`;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  $('#wsOn').onchange = e => { wsCfg.enabled = e.target.checked; updateWeapons(); };
  $('#wsChar').onchange = e => { wsCfg.character = +e.target.value; wsCfg.scroll = [0, 0, 0]; updateWeapons(); };
  $('#wsDp').onchange = e => { wsCfg.drebin = e.target.checked; updateWeapons(); };
  $('#wsBudget').onchange = e => { wsCfg.budget = num(e.target.value, 0); updateWeapons(); };
  $('#wsMult').onchange = e => { wsCfg.mult = num(e.target.value, 250); updateWeapons(); };
  P.querySelectorAll('[data-wsl]').forEach(t => t.onchange = () => {
    const i = +t.dataset.wsl;
    if (!parseList(t.value).length && t.value.trim()) { msg('No "<id> <cost>" pairs found in that list', true); return; }
    wsCfg.lists[i] = t.value.trim(); wsCfg.scroll[i] = 0; updateWeapons();
  });
  P.querySelectorAll('[data-wss]').forEach(r => r.oninput = () => { wsCfg.scroll[+r.dataset.wss] = +r.value; updateWeapons(); });
  $('#wsReset').onclick = () => { Object.assign(wsCfg, defaultConfig(), { budget: wsCfg.budget, mult: wsCfg.mult }); updateWeapons(); };
}

function tabObjects(P) {
  const la = S.la, kids = new Map();
  for (const o of la.objects) { if (!kids.has(o.parent)) kids.set(o.parent, []); kids.get(o.parent).push(o); }
  const textOf = o => { if (o.type !== 10 && o.type !== 11) return null; const p = la.packets(o.index).find(p => p.name === 'text'); return p ? latin1.decode(p.text) : null; };
  const hiddenOf = o => la.packets(o.index).some(p => p.name === 'hide');
  const out = [];
  if (la.layers.length > 1) out.push(`<div class="section"><h3>Layers</h3>${la.layers.map(([h, st, c], i) =>
    `<label style="margin-right:10px"><input type="checkbox" data-layer="${i}" ${S.hideLayer.has(i) ? '' : 'checked'}> ${i} #${hex(h)} <span class="dim">(${c}${st & 1 ? ', off' : ''})</span></label>`).join('')}</div>`);
  out.push(addForm(null));
  out.push('<div class="pad dim small">Untick to hide in the preview only (with children). Click to select; click in the preview to pick.</div>');
  let n = 0;
  const walk = (pid, depth) => {
    for (const o of kids.get(pid) || []) {
      if (n++ > 6000) return;
      const t = textOf(o), hid = hiddenOf(o);
      out.push(`<div class="obj${o.index === S.sel ? ' sel' : ''}${hid ? ' hidden' : ''}" data-i="${o.index}" style="padding-left:${6 + depth * 12}px">` +
        `<input type="checkbox" data-hide="${o.id}" ${S.hideObj.has(o.id) ? '' : 'checked'} aria-label="visible"> <span class="t">${o.type_name}</span> ` +
        `<span class="h">#${hex(o.hash)} id${o.id}</span>${t ? ` <span class="txt">"${esc(t)}"</span>` : ''}${hid ? ' (hidden)' : ''}${(o.flags & 0xFF) > 0x0B ? ' <span class="h">(guide shape, not drawn by the game)</span>' : ''}</div>`);
      walk(o.id, depth + 1);
    }
  };
  walk(0, 0);
  if (n > 6000) out.push('<div class="pad dim">… list truncated (very large file)</div>');
  P.innerHTML = out.join('');
  bindAdd(null);
  P.onclick = e => {
    const t = e.target;
    if (t.dataset.hide !== undefined) { const id = +t.dataset.hide; t.checked ? S.hideObj.delete(id) : S.hideObj.add(id); render(); return; }
    if (t.dataset.layer !== undefined) { const i = +t.dataset.layer; t.checked ? S.hideLayer.delete(i) : S.hideLayer.add(i); render(); return; }
    const d = t.closest('.obj');
    if (d) { S.sel = +d.dataset.i; S.tab = 'props'; render(); showTab(); }
  };
}

function fieldTable(fields) {
  return '<table>' + fields.map(f => `<tr><td class="k">${esc(f.label)}</td><td><input data-off="${f.offset}" data-fmt="${f.fmt}" value="${esc(Array.isArray(f.value) ? f.value.join(' ') : f.value)}"></td></tr>`).join('') + '</table>';
}
function bindFields(P) {
  P.querySelectorAll('input[data-off]').forEach(inp => inp.onchange = async () => {
    const off = +inp.dataset.off, fmt = inp.dataset.fmt;
    let v = inp.value;
    if (fmt === '4B') v = v.trim().split(/[\s,]+/).map(Number);
    else if (!fmt.endsWith('s')) v = v.startsWith('0x') ? parseInt(v, 16) : Number(v);
    if (fmt.endsWith('s') && latin1.encode(v).length !== parseInt(fmt)) {
      const block = (() => { for (let i = 0; i < S.la.nblocks; i++) if (S.la.blockOff[i] < off && off < S.la.blockOff[i] + S.la.blockSize(i)) return i; return -1; })();
      if (block >= 0) await edit(m => m.setText(block, v) || false, 'text changed');
      return;
    }
    await patchEdit(off, fmt, v);
  });
}
/** Fixed-size field: patch in place, recorded like any other edit. */
async function patchEdit(off, fmt, v, label = 'saved') {
  const before = current(), after = patch(new LA2(before), off, fmt, v);
  const e = editEntry();
  e.undo.push(before); e.redo = []; e.bytes = after;
  S.edits.set(S.file.id, e);
  await reopen(); msg(label);
}

function tabProps(P) {
  const la = S.la;
  if (S.sel === null || !la.objects[S.sel]) { P.innerHTML = '<div class="pad dim">Select an object in Objects or click one in the preview.</div>'; return; }
  const o = la.objects[S.sel];
  const packets = la.packets(S.sel);
  const names = Object.entries(PACKETS).filter(([v]) => v !== '0');
  P.innerHTML = `<div class="section"><b>${o.type_name}</b> <span class="dim">#${hex(o.hash)} · id ${o.id} · parent ${o.parent} · layer ${o.layer} · block ${S.sel} · flags 0x${(o.flags >>> 0).toString(16)}</span>
      <div class="dim small">Positions and sizes are 1/16 px. color_index: low 12 bits = colour-table entry, top 4 bits = channel mask (RGBA). Text can be any length.</div></div>
    <div class="section"><h3>Fields</h3>${fieldTable(statusFields(la, S.sel))}</div>
    <div class="section"><h3>Duplicate / delete</h3><div class="addrow">dx <input id="dupx" value="16"> dy <input id="dupy" value="0"> <button id="dup">Duplicate with children</button> <button id="del">Delete with children</button></div></div>
    ${addForm(S.sel)}
    <div class="section"><h3>Raw packets</h3><div class="dim small">Type + data hex in file byte order; add, remove or resize freely, the file is rebuilt.</div>
      <table id="pk">${packets.filter(p => p.type).map(p => pkRow(p.type, toHex(la.data.subarray(p.offset + 4, p.offset + p.size)), names)).join('')}</table>
      <button id="pkadd">+ packet</button> <button id="pksave">Save packets</button></div>`;
  bindFields(P); bindAdd(S.sel);
  $('#dup').onclick = async () => {
    const idx = await edit(m => m.duplicate(S.sel, Math.round(+$('#dupx').value * 16), Math.round(+$('#dupy').value * 16)), 'duplicated');
    if (idx !== undefined) { S.sel = idx; render(); showTab(); }
  };
  $('#del').onclick = async () => {
    if (!confirm('Delete this object, its children, their tracks and key states?')) return;
    const keep = S.sel; S.sel = null;
    const n = await edit(m => m.delete(keep), 'deleted');
    if (n !== undefined) { msg('removed ' + n + ' objects'); S.tab = 'objects'; showTab(); }
  };
  const tb = $('#pk');
  tb.onclick = e => { if (e.target.classList.contains('pdel')) e.target.closest('tr').remove(); };
  $('#pkadd').onclick = () => { const t = document.createElement('tbody'); t.innerHTML = pkRow(1, '', names); tb.appendChild(t.firstChild); };
  $('#pksave').onclick = async () => {
    const pk = [...tb.querySelectorAll('tr')].map(tr => ({ type: +tr.querySelector('.pt').value, data: fromHex(tr.querySelector('.ph').value) }));
    const pos = S.sel;
    await edit(m => m.setPackets(pos, pk), 'packets saved');
  };
}
function pkRow(type, hexData, names) {
  return `<tr><td><select class="pt">${names.map(([v, n]) => `<option value="${v}"${+v === type ? ' selected' : ''}>${v} ${n}</option>`).join('')}</select></td>
    <td><input class="ph mono" value="${hexData}"></td><td><button class="pdel" title="remove">×</button></td></tr>`;
}

// ---- Text: every string in the file, edited in place ---------------------------------------------------------------
/** Characters of `s` the font has no glyph for, tokenised like Scene.layout (longest code first, line breaks skipped). */
function missingGlyphs(font, s) {
  const miss = new Set();
  for (let i = 0; i < s.length;) {
    const two = s.substr(i, 2);
    if (s[i] === '\n' || s[i] === '\r') { i++; continue; }
    if (two === '\\n' || two === '\\r') { i += 2; continue; }
    const n = [4, 3, 2, 1].find(k => font.glyphs.has(s.substr(i, k)));
    if (n) i += n; else miss.add(s[i++]);
  }
  return [...miss];
}
const showChar = c => { const v = c.charCodeAt(0); return c === ' ' ? 'space' : v < 0x21 || (v >= 0x7F && v < 0xA1) ? '\\x' + v.toString(16).padStart(2, '0') : c; };
function tabText(P) {
  const la = S.la, focus = S.textFocus, texts = la.texts(), nobj = la.objects.length;
  const byId = new Map(la.objects.map(o => [o.id, o]));
  // strings in key target blocks belong to the objects of the tracks whose set / morph keys point at them
  const later = new Set(texts.filter(t => t.block >= nobj).map(t => t.block));
  const keyed = later.size ? la.keyTargets(later) : new Map();
  const fontId = b => la.packets(b).find(p => p.name === 'text_layout')?.values[2];
  const nth = new Map();
  const rows = texts.slice(0, 3000).map((t, i) => {
    const uses = t.block < nobj ? [] : keyed.get(t.block) || [];
    const owner = t.block < nobj ? la.objects[t.block] : uses.length ? byId.get(uses[0].object) : null;
    const k = nth.get(t.block) || 0; nth.set(t.block, k + 1);
    const fid = fontId(t.block) ?? (owner ? fontId(owner.index) : undefined) ?? 1;
    const font = la.fonts[fid > 0 ? fid - 1 : 0] || la.fonts[0], s = latin1.decode(t.text);
    return { ...t, i, nth: k, s, owner, uses, font: la.fonts.indexOf(font), missing: font ? missingGlyphs(font, s) : [] };
  });
  const actName = a => `action ${a}${la.actionHash.has(a) ? ' #' + hex(la.actionHash.get(a)) : ''}`;
  const where = r => r.block < nobj ? 'initial state' : r.uses.length ? 'set by ' + r.uses.map(u => `<a data-act="${u.action}">${actName(u.action)}</a>`).join(', ') : `block ${r.block} (no key uses it)`;
  const label = r => r.owner ? `<a data-obj="${r.owner.index}">${r.owner.type_name} #${hex(r.owner.hash)} id${r.owner.id}</a>` : `block ${r.block}`;
  P.innerHTML = `<div class="section"><div class="addrow"><input id="textFilter" placeholder="Filter text…" aria-label="Filter text" style="flex:1;width:auto"> <span class="dim small" id="textCount"></span></div>
      <div class="dim small">Every string in the layout: String / Typing text and text that action keys set. Enter applies (any length),
      Shift+Enter starts a new line, Esc restores; each change is one undo step. Click a name to open its properties.</div></div>` +
    (la.fonts.length ? `<details class="section" id="glyphs"${S.glyphsOpen ? ' open' : ''}><summary class="small">Font characters</summary>
      <div class="addrow small">font <select id="glyphFont">${la.fonts.map((f, i) => `<option value="${i}">${i + 1} · #${hex(f.hash)} · ${f.glyphs.size} glyphs</option>`).join('')}</select>
      <span class="dim">click one to insert it into the string being edited</span></div><div class="glyphs" id="glyphList"></div></details>` : '') +
    (rows.length ? rows.map(r => `<div class="trow" data-ti="${r.i}"><div class="tmeta">${label(r)} · ${where(r)}</div>
      <textarea data-ti="${r.i}" rows="${Math.min(6, r.s.split('\n').length)}" spellcheck="false" aria-label="Text ${r.i + 1}"></textarea>
      ${r.missing.length ? `<div class="warn small">not in the font, not drawn: ${r.missing.map(c => esc(showChar(c))).join(' ')}</div>` : ''}</div>`).join('')
      : '<div class="pad dim">This layout has no text.</div>') +
    (texts.length > rows.length ? `<div class="pad dim">… ${texts.length - rows.length} more strings</div>` : '');
  const commit = async (ta, keepFocus) => {
    const r = rows[+ta.dataset.ti], v = ta.value;
    if (v === ta.defaultValue || ta.dataset.busy) return;
    if (/[^\x00-\xff]/.test(v)) { msg('Text is stored as single bytes: only Latin-1 characters fit', true); return; }
    ta.dataset.busy = '1';
    if (keepFocus) S.textFocus = { i: r.i, caret: ta.selectionStart };
    try {
      if (v.length === r.text.length) await patchEdit(r.offset + 8, v.length + 's', v, 'text changed');
      else await edit(m => m.setText(r.block, v, r.nth) || false, 'text changed');
    } finally { delete ta.dataset.busy; }
  };
  P.querySelectorAll('textarea[data-ti]').forEach(ta => {
    const r = rows[+ta.dataset.ti];
    ta.defaultValue = r.s;               // set as text, not parsed: keeps leading line breaks
    ta.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commit(ta, true); }
      else if (e.key === 'Escape') ta.value = ta.defaultValue;
    };
    ta.onchange = () => commit(ta, false);
    // focus picks the object in the preview; it comes back after the edit re-renders this tab
    ta.onfocus = () => {
      if (S.textFocus?.i !== r.i) S.textFocus = { i: r.i, caret: null };
      if (glyphFont && r.font >= 0 && +glyphFont.value !== r.font) { glyphFont.value = String(r.font); S.glyphFont = r.font; drawGlyphs(); }
      if (r.owner && S.sel !== r.owner.index) { S.sel = r.owner.index; render(); }
    };
    ta.onblur = e => { if (!e.relatedTarget?.matches?.('textarea[data-ti]')) S.textFocus = null; };
  });
  const glyphFont = $('#glyphFont');
  const drawGlyphs = () => {
    const keys = [...la.fonts[+glyphFont.value].glyphs.keys()].filter(k => k !== '\n' && k !== '\r');
    $('#glyphList').innerHTML = keys.map((k, n) => `<button class="glyph" data-g="${n}" title="${esc([...k].map(c => '0x' + c.charCodeAt(0).toString(16)).join(' '))}">${esc(showChar(k))}</button>`).join('');
    $('#glyphList').onmousedown = e => e.preventDefault();          // keep the string's caret
    $('#glyphList').onclick = e => {
      const b = e.target.closest('[data-g]'), ta = document.activeElement;
      if (!b || !ta?.matches?.('textarea[data-ti]')) { if (b) msg('Click into a string first, then pick a character'); return; }
      ta.setRangeText(keys[+b.dataset.g], ta.selectionStart, ta.selectionEnd, 'end');
    };
  };
  if (glyphFont) {
    glyphFont.value = String(Math.min(S.glyphFont || 0, la.fonts.length - 1));
    glyphFont.onchange = () => { S.glyphFont = +glyphFont.value; drawGlyphs(); };
    $('#glyphs').ontoggle = () => { S.glyphsOpen = $('#glyphs').open; };
    drawGlyphs();
  }
  const filter = $('#textFilter');
  const applyFilter = () => {
    const w = filter.value.toLowerCase();
    let n = 0;
    P.querySelectorAll('.trow').forEach(d => {
      const show = !w || rows[+d.dataset.ti].s.toLowerCase().includes(w) || d.querySelector('.tmeta').textContent.toLowerCase().includes(w);
      d.hidden = !show; n += show;
    });
    $('#textCount').textContent = `${n} of ${texts.length}`;
  };
  filter.value = S.textFilter;
  filter.oninput = () => { S.textFilter = filter.value; applyFilter(); };
  applyFilter();
  P.onclick = e => {
    const o = e.target.closest('[data-obj]'), a = e.target.closest('[data-act]');
    if (o) { S.sel = +o.dataset.obj; S.tab = 'props'; render(); showTab(); }
    else if (a) { $('#action').value = a.dataset.act; $('#action').onchange(); }
  };
  const back = focus && P.querySelector(`textarea[data-ti="${focus.i}"]`);
  if (back && !back.closest('.trow').hidden) {
    back.focus();
    const c = focus.caret ?? back.value.length;
    back.setSelectionRange(c, c);
  }
}

function tabTextures(P) {
  const la = S.la, lib = S.lib;
  const rows = la.tex_tbl.map(([h], i) => ({ i: i + 1, h, info: lib.lookup(h) }));
  P.innerHTML = '<div class="texgrid">' + rows.map(r => `<div class="tex" data-h="${r.h}">` +
    (r.info ? `<canvas data-tc="${r.i}"></canvas>` : '<div class="dim small" style="padding:20px 4px">not found in this folder</div>') +
    `<div class="cap">#${r.i} · ${hex(r.h)}${r.info ? ` · ${r.info.w}×${r.info.h}` : ''}</div>` +
    (r.info ? `<div class="cap" title="${esc(r.info.loc)}">${esc(r.info.loc.split('|').map((s, k) => k ? s : basename(s)).join(' · '))}</div>
      <div class="acts"><a data-dl="${r.i}">PNG</a><label>replace…<input type="file" accept="image/png,image/*" data-rep="${r.i}" hidden></label></div>` : '') + '</div>').join('') + '</div>' +
    (rows.some(r => !r.info) ? '<div class="pad"><button id="searchAll">Search everything for missing textures</button> <span class="dim small">indexes every archive in the opened folder</span></div>' : '') +
    '<div class="pad dim small">Pink outlines are the UV rectangles objects use. “replace…” imports an image (resized to the texture; atlas regions are pasted into their atlas), re-encodes it as DXT with the same mip layout and keeps an edited copy of the DLZ; “Save textures” downloads it.</div>';
  // thumbnails with UV outlines
  const used = new Map();
  la.objects.forEach((o, i) => {
    const ps = la.packets(i), t = ps.find(p => p.name === 'texture'), u = ps.find(p => p.name === 'uv');
    if (t && u) { if (!used.has(t.value)) used.set(t.value, new Set()); used.get(t.value).add(u.value); }
  });
  P.querySelectorAll('canvas[data-tc]').forEach(c => {
    const i = +c.dataset.tc, h = la.tex_tbl[i - 1][0], info = lib.lookup(h), img = lib.image(h);
    if (!info || !img) return;
    c.width = info.w || img.w; c.height = info.h || img.h;
    const ctx = c.getContext('2d'), id = new ImageData(c.width, c.height);
    for (let y = 0; y < c.height; y++) id.data.set(img.rgba.subarray(((y + info.oy) * img.w + info.ox) * 4, ((y + info.oy) * img.w + info.ox + c.width) * 4), y * c.width * 4);
    ctx.putImageData(id, 0, 0);
    ctx.strokeStyle = '#ff40c8'; ctx.lineWidth = Math.max(1, c.width / 150);
    for (const u of used.get(i) || []) {
      const pts = la.uv_tbl[u];
      if (!pts) continue;
      const off = la.version === 0x10009 ? [0, 0] : [-info.ox, -info.oy];
      if (pts.length === 2) ctx.strokeRect(pts[0][0] + off[0], pts[0][1] + off[1], pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      else if (pts.length >= 3) { ctx.beginPath(); pts.forEach(([x, y], k) => k ? ctx.lineTo(x + off[0], y + off[1]) : ctx.moveTo(x + off[0], y + off[1])); ctx.closePath(); ctx.stroke(); }
    }
  });
  P.onclick = e => {
    const d = e.target.closest('[data-dl]');
    if (!d) return;
    const i = +d.dataset.dl, h = la.tex_tbl[i - 1][0], info = lib.lookup(h), img = lib.image(h);
    const w = info.w || img.w, hh = info.h || img.h, out = new Uint8Array(w * hh * 4);
    for (let y = 0; y < hh; y++) out.set(img.rgba.subarray(((y + info.oy) * img.w + info.ox) * 4, ((y + info.oy) * img.w + info.ox + w) * 4), y * w * 4);
    download(encodePNG(w, hh, out), `${i}_${hex(h)}.png`);
  };
  P.querySelectorAll('input[data-rep]').forEach(inp => inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const i = +inp.dataset.rep, h = la.tex_tbl[i - 1][0];
    busy(1, 'encoding texture…');
    try {
      const written = await replaceTexture(S.lib, h, file, S.texEdits);
      S.lib.pools.clear(); S.lib.resetResolved(); renderer.dropTextures();
      updateSaveButtons();
      await reopen();
      msg('texture replaced in ' + written.map(basename).join(', '));
    } catch (e) { msg('Replace failed: ' + e.message, true); }
    finally { busy(-1); }
  });
  const sa = $('#searchAll');
  if (sa) sa.onclick = async () => {
    busy(1, 'indexing every archive…');
    try {
      await S.lib.searchAll((k, n, p) => { $('#busy').textContent = `indexing ${k + 1}/${n}: ${basename(p)}`; });
      S.lib.resetResolved(); renderer.dropTextures();
      await reopen();
    } finally { busy(-1); }
  };
}

function tabTables(P) {
  const m = new Model(current());
  const rows = {
    color: (m.color_tbl || []).map(l => l.map(c => [...c])),
    uv: (m.uv_tbl || []).map(l => l.map(c => { const r = new Reader(c, m.le); return [r.u16(0), r.u16(2)]; })),
    tex: (m.tex_tbl || []).map(([h, t]) => [hex(h), hex(t)]),
  };
  const swatch = c => `<span class="swatch" style="background:rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, c[3] / 128)})"></span>`;
  P.innerHTML = `<div class="section"><h3>Colours</h3><div class="dim small">R G B 0–255, alpha 0x80 = opaque. One entry holds a colour per vertex (Quad 4, Line 2…).</div>
      <table>${rows.color.slice(0, 400).map((l, i) => `<tr><td class="k">${i}</td><td>${l.map(swatch).join(' ')} <span class="dim mono">${l.map(c => c.join(',')).join(' · ')}</span></td></tr>`).join('')}</table></div>
    <div class="section"><h3>Edit tables (JSON)</h3><div class="dim small">colour entries: lists of [R,G,B,A]; UV entries: lists of [u,v] texture pixels; textures: [TXN texture hash, TRI hash] in hex. Objects refer to entries by index: append to add, remove only unused ones at the end.</div>
      <textarea id="tbljson" spellcheck="false">${esc(JSON.stringify(rows, null, 1))}</textarea>
      <button id="tblsave">Save tables</button></div>`;
  $('#tblsave').onclick = async () => {
    let body;
    try { body = JSON.parse($('#tbljson').value); } catch (e) { msg('Bad JSON: ' + e.message, true); return; }
    await edit(mm => {
      if (body.color && mm.color_tbl) mm.color_tbl = body.color.map(l => l.map(c => Uint8Array.from(c.map(v => v & 255))));
      if (body.uv && mm.uv_tbl) mm.uv_tbl = body.uv.map(l => l.map(([u, v]) => { const b = new Uint8Array(4), dv = new DataView(b.buffer); dv.setUint16(0, u, mm.le); dv.setUint16(2, v, mm.le); return b; }));
      if (body.tex && mm.tex_tbl) mm.tex_tbl = body.tex.map(([h, t]) => [parseInt(h, 16), parseInt(t, 16)]);
    }, 'tables saved');
  };
}

function keyDesc(k) {
  if (k.type === 1) {
    const r = new Reader(k.data, S.la.le), n = k.data.length >= 4 ? r.u32(0) : 0, out = [];
    for (let i = 0; i < n && 8 + 8 * i <= k.data.length; i++) {
      const c = r.u32(4 + 8 * i), arg = r.u32(8 + 8 * i), t = S.la.named.get(arg);
      out.push(`${COMMANDS.get(c) || 'signal #' + hex(c)}(${t !== undefined ? 'action ' + t : '#' + hex(arg)})`);
    }
    return out.join(', ');
  }
  if ((k.type === 4 || k.type === 8) && k.data.length >= 4) return new Reader(k.data, S.la.le).u32(0) + ' frames';
  if (k.type === 2 && k.data.length >= 4) return 'action #' + hex(new Reader(k.data, S.la.le).u32(0));
  return '';
}
function tabKeys(P) {
  const a = +$('#action').value;
  if (a < 0) { P.innerHTML = '<div class="pad dim">Pick an action in the toolbar.</div>'; return; }
  const la = S.la, act = la.actions[a];
  const byId = new Map(la.objects.map(o => [o.id, o]));
  const KN = { 0: 'end', 1: 'commands', 2: 'call', 3: 'return', 4: 'wait', 7: 'set', 8: 'morph' };
  const keyRow = k => `<tr><td><select class="kt">${Object.entries(KN).map(([v, n]) => `<option value="${v}"${+v === k.type ? ' selected' : ''}>${n}</option>`).join('')}</select></td>
    <td><input class="kh mono" value="${toHex(k.data)}">${keyDesc(k) ? `<div class="dim small">${esc(keyDesc(k))}</div>` : ''}</td>
    <td><input class="kr" value="${k.pos ?? ''}" data-delta="${k.delta || 0}" style="width:64px" title="status block (set / morph)"></td><td><button class="kdel" title="remove">×</button></td></tr>`;
  const limit = 200;
  P.innerHTML = `<div class="section"><label><input type="checkbox" id="actloop" ${act.flags ? 'checked' : ''}> <b>Loops</b></label> <span class="dim small">(header usFlags: the game plays it looping)</span>
      <div class="dim small">Keys per track: set / morph point at a status block (blocks 0…${la.objects.length - 1} are the objects' initial states, later ones are key targets); morph and wait data start with their frame count. Edit, add or remove keys, then save the track.</div></div>` +
    act.tracks.slice(0, limit).map((tr, ti) => {
      const o = byId.get(tr.object);
      const shown = la.keys(a, ti, 400).map(k => {
        const data = la.data.subarray(k.offset + 4, k.offset + Math.max(4, k.size));
        const tgt = k.type === 7 ? k.value : k.type === 8 ? k.status : null, at = tgt !== null ? la.blockAt(tgt) : null;
        return { type: k.type, data, pos: at ? at[0] : null, delta: at ? at[1] : 0 };
      });
      return `<div class="section" data-track="${ti}"><b>Track ${ti}: object id ${tr.object}</b> <span class="dim">${o ? o.type_name + ' #' + hex(o.hash) : ''} · ${tr.nkeys} keys</span>
        <table>${shown.map(keyRow).join('')}</table>${tr.nkeys > shown.length ? `<div class="dim small">… ${tr.nkeys - shown.length} more keys (too many to edit here)</div>` : `<button data-addkey="${ti}">+ key</button> <button data-savekeys="${ti}">Save track</button>`}</div>`;
    }).join('') + (act.tracks.length > limit ? `<div class="pad dim">… ${act.tracks.length - limit} more tracks</div>` : '');
  $('#actloop').onchange = () => edit(mm => mm.setActionLoop(a, $('#actloop').checked), 'loop flag saved');
  P.onclick = async e => {
    const t = e.target;
    if (t.classList.contains('kdel')) { t.closest('tr').remove(); return; }
    if (t.dataset.addkey !== undefined) {
      const tb = P.querySelector(`[data-track="${t.dataset.addkey}"] table tbody`) || P.querySelector(`[data-track="${t.dataset.addkey}"] table`);
      const tmp = document.createElement('tbody'); tmp.innerHTML = keyRow({ type: 4, data: Uint8Array.of(0, 0, 0, 10), pos: null });
      const rows = tb.querySelectorAll('tr'); tb.insertBefore(tmp.firstChild, rows[rows.length - 1] || null);
      return;
    }
    if (t.dataset.savekeys !== undefined) {
      const ti = +t.dataset.savekeys;
      const keys = [...P.querySelectorAll(`[data-track="${ti}"] tr`)].map(tr => ({ type: +tr.querySelector('.kt').value,
        data: fromHex(tr.querySelector('.kh').value), pos: tr.querySelector('.kr').value, delta: +tr.querySelector('.kr').dataset.delta || 0 }));
      await edit(mm => mm.setKeys(a, ti, keys), 'track saved');
    }
  };
}

function tabFile(P) {
  const la = S.la, d = la.data, r = la.r;
  const offs = SECTION_NAMES.map((n, i) => [n, r.u32(4 + 4 * i)]);
  const sorted = offs.filter(([, o]) => o).map(([, o]) => o).sort((a, b) => a - b).concat([d.length]);
  const size = o => o ? sorted[sorted.indexOf(o) + 1] - o : 0;
  const row = (a, b, c = '') => `<tr><td class="k">${a}</td><td>${b}</td><td class="dim">${c}</td></tr>`;
  P.innerHTML = `<div class="section"><b>${esc(S.file.id)}</b><div class="dim small">version 0x${la.version.toString(16)} · ${la.le ? 'little-endian (PC)' : 'big-endian (PS3)'} · ${d.length} bytes${S.edits.has(S.file.id) ? ' · edited' : ''}</div></div>
    <div class="section"><h3>Sections (tagLA2_HEADER)</h3><table>${offs.map(([n, o]) => row(n, o ? '0x' + o.toString(16) : '—', o ? size(o) + ' bytes' : '')).join('')}</table></div>
    <div class="section"><h3>Object counts (tagLA2_OBJ_DEF_HEADER)</h3><div class="dim small">Rebuilt on every structural edit.</div><table>${OBJ_DEF_NAMES.map((n, i) => row(n, la.obj_counts[i])).join('')}</table></div>
    <div class="section"><h3>Layers</h3><table>${la.layers.map(([h, st, c], i) => row(i + ' #' + hex(h), c + ' objects', 'status ' + st + (st & 1 ? ' (display off)' : ''))).join('') || row('none', '')}</table></div>
    <div class="section"><h3>Fonts</h3><table>${la.fonts.map((f, i) => row('font ' + (i + 1), '#' + hex(f.hash), f.glyphs.size + ' glyphs')).join('') || row('none', '')}</table></div>
    <div class="section dim small">${la.actions.length} actions (${la.named.size} named) · ${la.nblocks} status blocks · TRI ${la.tri.map(t => hex(t)).join(', ') || '—'}</div>`;
}

// ---- development / automated tests: ?dev=<url of tests/serve.py> [&folder=...][&file=...] -------------------------
const qs = new URLSearchParams(location.search);
if (qs.get('dev')) {
  (async () => {
    await openFS(new HttpFS(qs.get('dev')));
    if (qs.get('folder')) await selectFolder(qs.get('folder'));
    if (qs.get('file')) { const f = S.files.find(x => x.id === qs.get('file') || x.id.endsWith(qs.get('file'))); if (f) await openFile(f); }
    window.__la2ready = true;
  })();
}
window.__la2 = { S, render, openFile, selectFolder, edit, renderer: () => renderer, crop: cropControls };
showTab();
