// DXT1 / DXT3 / DXT5 block encoder (bounding-box endpoints with inset, nearest palette index) and mip generation,
// used to write replaced textures back in the game's own formats.

const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = c => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];

function colorBlock(px, out, o, dxt1) {
  let mn = [255, 255, 255], mx = [0, 0, 0], any = false, transparent = false;
  for (let i = 0; i < 16; i++) {
    if (dxt1 && px[i * 4 + 3] < 128) { transparent = true; continue; }
    any = true;
    for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], px[i * 4 + c]); mx[c] = Math.max(mx[c], px[i * 4 + c]); }
  }
  if (!any) { mn = [0, 0, 0]; mx = [0, 0, 0]; }
  for (let c = 0; c < 3; c++) { const inset = (mx[c] - mn[c]) / 16; mn[c] = Math.max(0, mn[c] + inset); mx[c] = Math.min(255, mx[c] - inset); }
  let c0 = to565(mx[0] | 0, mx[1] | 0, mx[2] | 0), c1 = to565(mn[0] | 0, mn[1] | 0, mn[2] | 0);
  const three = dxt1 && transparent;                 // DXT1 3-colour mode (index 3 = transparent) needs c0 <= c1
  if (three ? c0 > c1 : c0 < c1) [c0, c1] = [c1, c0];
  if (!three && c0 === c1) { if (c0 > 0) c1 = c0 - 1; else c0 = 1; }
  const a = from565(c0), b = from565(c1);
  const pal = three ? [a, b, a.map((v, i) => (v + b[i]) / 2)] : [a, b, a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)];
  let idx = 0;
  for (let i = 15; i >= 0; i--) {
    let best = 0;
    if (three && px[i * 4 + 3] < 128) best = 3;
    else {
      let bd = Infinity;
      pal.forEach((p, k) => {
        const d = (px[i * 4] - p[0]) ** 2 + (px[i * 4 + 1] - p[1]) ** 2 + (px[i * 4 + 2] - p[2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      });
    }
    idx = (idx * 4 + best) >>> 0;
  }
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
  out[o + 4] = idx & 255; out[o + 5] = (idx >>> 8) & 255; out[o + 6] = (idx >>> 16) & 255; out[o + 7] = idx >>> 24;
}

function alphaBlock5(px, out, o) {
  let mn = 255, mx = 0;
  for (let i = 0; i < 16; i++) { mn = Math.min(mn, px[i * 4 + 3]); mx = Math.max(mx, px[i * 4 + 3]); }
  out[o] = mx; out[o + 1] = mn;
  const av = [mx, mn];
  if (mx > mn) for (let i = 1; i < 7; i++) av.push(((7 - i) * mx + i * mn) / 7);
  else for (let i = 0; i < 6; i++) av.push(mx);
  let bits = 0n;
  for (let i = 0; i < 16; i++) {
    let best = 0, bd = Infinity;
    av.forEach((v, k) => { const d = Math.abs(px[i * 4 + 3] - v); if (d < bd) { bd = d; best = k; } });
    bits |= BigInt(best) << BigInt(3 * i);
  }
  for (let i = 0; i < 6; i++) out[o + 2 + i] = Number((bits >> BigInt(8 * i)) & 255n);
}

function alphaBlock3(px, out, o) {
  for (let i = 0; i < 8; i++) out[o + i] = (px[i * 8 + 3] >> 4) | ((px[i * 8 + 7] >> 4) << 4);
}

/** RGBA (w x h) -> DXT blocks (fourcc 9 = DXT1, 10 = DXT3, 11 = DXT5). */
export function encodeDxt(w, h, rgba, fourcc) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2), bs = fourcc === 9 ? 8 : 16;
  const out = new Uint8Array(bw * bh * bs), px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    for (let k = 0; k < 16; k++) {
      const x = Math.min(w - 1, bx * 4 + (k & 3)), y = Math.min(h - 1, by * 4 + (k >> 2));
      px.set(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), k * 4);
    }
    const o = (by * bw + bx) * bs;
    if (fourcc === 9) colorBlock(px, out, o, true);
    else { (fourcc === 11 ? alphaBlock5 : alphaBlock3)(px, out, o); colorBlock(px, out, o + 8, false); }
  }
  return out;
}

/** Half-size box filter. */
export function downsample(w, h, rgba) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
    let s = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(w - 1, 2 * x + dx), sy = Math.min(h - 1, 2 * y + dy);
      s += rgba[(sy * w + sx) * 4 + c]; n++;
    }
    out[(y * nw + x) * 4 + c] = (s / n + 0.5) | 0;
  }
  return { w: nw, h: nh, rgba: out };
}

/** DXT data of `levels` mip levels of an image. */
export function mipChain(w, h, rgba, fourcc, levels) {
  const out = [];
  let cur = { w, h, rgba };
  for (let k = 0; k < levels; k++) {
    if (k) cur = downsample(cur.w, cur.h, cur.rgba);
    out.push(encodeDxt(cur.w, cur.h, cur.rgba, fourcc));
  }
  return out;
}
