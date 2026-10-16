// WebGL2 renderer for draw lists from Scene.primitives(): textured, per-vertex coloured triangle fans and 1 px
// lines, with libla's blend modes (the PS3 build's DG_SetBlendMode):
//   normal  src * srcAlpha + dst * (1 - srcAlpha)
//   add     src * srcAlpha + dst
//   sub     dst - src * srcAlpha        (reverse subtract)
//   none    blending off (opaque)

const VS = `#version 300 es
in vec2 aPos; in vec2 aUV; in vec4 aCol;
uniform vec4 uView;   // x0, y0 (px), 2 * scale / w, 2 * scale / h
out vec2 vUV; out vec4 vCol;
void main() {
  vec2 p = (aPos - uView.xy) * uView.zw;
  gl_Position = vec4(p.x - 1.0, 1.0 - p.y, 0.0, 1.0);
  vUV = aUV; vCol = aCol;
}`;
const FS = `#version 300 es
precision highp float;
in vec2 vUV; in vec4 vCol;
uniform sampler2D uTex; uniform bool uUseTex;
out vec4 o;
void main() {
  vec4 c = vCol;
  if (uUseTex) c *= texture(uTex, vUV);
  o = c;
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Renderer {
  /** @param {HTMLCanvasElement | OffscreenCanvas} canvas */
  constructor(canvas) {
    const gl = this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.canvas = canvas;
    const p = this.prog = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.loc = { pos: gl.getAttribLocation(p, 'aPos'), uv: gl.getAttribLocation(p, 'aUV'), col: gl.getAttribLocation(p, 'aCol'),
      view: gl.getUniformLocation(p, 'uView'), tex: gl.getUniformLocation(p, 'uTex'), useTex: gl.getUniformLocation(p, 'uUseTex') };
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.loc.uv); gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.loc.col); gl.vertexAttribPointer(this.loc.col, 4, gl.FLOAT, false, stride, 16);
    this.textures = new Map();    // image key -> {tex, w, h}
    this.data = new Float32Array(1 << 16);
  }

  /** Upload (once) an RGBA image for texture `key`; getImage() -> {w, h, rgba} or null. */
  texture(key, getImage) {
    if (this.textures.has(key)) return this.textures.get(key);
    const img = getImage();
    if (!img) { this.textures.set(key, null); return null; }
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.w, img.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const e = { tex: t, w: img.w, h: img.h };
    this.textures.set(key, e);
    return e;
  }
  dropTextures() {
    for (const e of this.textures.values()) if (e) this.gl.deleteTexture(e.tex);
    this.textures.clear();
  }

  _blend(mode) {
    const gl = this.gl;
    if (mode === 'none') { gl.disable(gl.BLEND); return; }
    gl.enable(gl.BLEND);
    if (mode === 'add') { gl.blendEquation(gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE); }
    else if (mode === 'sub') { gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE); }
    else { gl.blendEquation(gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
  }

  /**
   * Draw a frame. view {x, y, w, h} in layout px, scale, bg [r, g, b] 0..255; textures(hash) -> {key, image()}.
   * The canvas is resized to view * scale.
   */
  draw(prims, view, scale, bg, textures, outline = null) {
    const gl = this.gl;
    const W = Math.max(8, Math.round(view.w * scale)), H = Math.max(8, Math.round(view.h * scale));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform4f(this.loc.view, view.x, view.y, 2 * scale / W, 2 * scale / H);
    gl.uniform1i(this.loc.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    // batch consecutive primitives with the same texture and blend mode
    let n = 0, cur = null;
    const flush = () => {
      if (!n || !cur) { n = 0; return; }
      this._blend(cur.blend);
      gl.uniform1i(this.loc.useTex, cur.t ? 1 : 0);
      if (cur.t) gl.bindTexture(gl.TEXTURE_2D, cur.t.tex);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, n * 8), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, n);
      n = 0;
    };
    const vert = (x, y, u, v, c) => {
      if ((n + 1) * 8 > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
      const o = n * 8, d = this.data;
      d[o] = x; d[o + 1] = y; d[o + 2] = u; d[o + 3] = v; d[o + 4] = c[0]; d[o + 5] = c[1]; d[o + 6] = c[2]; d[o + 7] = c[3];
      n++;
    };
    for (const p of prims) {
      let t = null;
      if (p.tex !== null && p.tex !== undefined && p.uv) {
        const src = textures(p.tex);
        t = src ? this.texture(src.key, src.image) : null;
      }
      if (!cur || cur.t !== t || cur.blend !== p.blend) { flush(); cur = { t, blend: p.blend }; }
      const iw = t ? t.w : 1, ih = t ? t.h : 1;
      if (p.kind === 'lines') {
        // the GPU draws 1 px lines; here a quad per segment, 1 px wide at zoom 1
        const w = Math.max(1, scale) / scale / 2;
        for (let k = 0; k + 1 < p.pts.length; k++) {
          const [ax, ay] = p.pts[k], [bx, by] = p.pts[k + 1];
          const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, nx = -dy / l * w, ny = dx / l * w;
          const ca = p.cols[k], cb = p.cols[k + 1];
          const q = [[ax + nx, ay + ny, ca], [bx + nx, by + ny, cb], [bx - nx, by - ny, cb], [ax - nx, ay - ny, ca]];
          for (const i of [0, 1, 2, 0, 2, 3]) vert(q[i][0], q[i][1], 0, 0, q[i][2]);
        }
        continue;
      }
      if (p.pts.length < 3) continue;
      for (let i = 1; i + 1 < p.pts.length; i++) {
        for (const k of [0, i, i + 1]) {
          const uv = t && p.uv && p.uv[k] ? p.uv[k] : [0, 0];
          vert(p.pts[k][0], p.pts[k][1], uv[0] / iw, uv[1] / ih, p.cols[k]);
        }
      }
    }
    flush();
    if (outline && outline.length) this._outline(outline, view, scale);
  }

  /** Pink outlines (selected object and its children), drawn as thin lines over the frame. */
  _outline(polys, view, scale) {
    const gl = this.gl, pink = [1, 0.25, 0.78, 1], w = 0.75 / scale;
    let n = 0;
    const d = [];
    for (const pts of polys) {
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % pts.length];
        const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, nx = -dy / l * w, ny = dx / l * w;
        const q = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
        for (const i of [0, 1, 2, 0, 2, 3]) { d.push(q[i][0], q[i][1], 0, 0, ...pink); n++; }
      }
    }
    if (!n) return;
    this._blend('normal');
    gl.uniform1i(this.loc.useTex, 0);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, n);
  }

  /** Current frame as RGBA rows top to bottom. */
  pixels() {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const row = W * 4, out = new Uint8Array(px.length);
    for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    return { w: W, h: H, rgba: out };
  }
}
