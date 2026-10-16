// Texture replacement: an image is resized to the texture's region, pasted into its atlas, re-encoded with the
// original DXT format and mip layout, and written into every DLD entry holding that image (sizes unchanged, so all
// DLD offsets stay valid). The edited DLD is kept in `texEdits` (by DLZ path) until saved.
import { inflateDlz } from '../formats/archives.js';
import { levelSizes, dldEntries, FOURCC } from '../formats/textures.js';
import { mipChain } from '../formats/dxtenc.js';
import { concat } from '../core/bin.js';

async function imageRGBA(file, w, h) {
  const bmp = await createImageBitmap(file);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
}

export async function replaceTexture(lib, hash, file, texEdits) {
  const r = lib.resolved?.get(hash);
  if (!r) throw new Error('texture not loaded');
  const { info, loc } = r, { w, h, fourcc } = info.img;
  if (!FOURCC[fourcc]) throw new Error('unsupported texture format ' + fourcc);
  const full = lib.image(hash);
  const rw = info.w || w, rh = info.h || h;
  const region = await imageRGBA(file, rw, rh);
  const atlas = full.rgba.slice();
  for (let y = 0; y < rh; y++) atlas.set(region.subarray(y * rw * 4, (y + 1) * rw * 4), ((y + info.oy) * w + info.ox) * 4);
  const sizes = levelSizes(w, h, fourcc);
  const chain = mipChain(w, h, atlas, fourcc, sizes.length);
  const written = [];
  for (const p of lib.dlzFor(loc)) {
    const dld = (texEdits.get(p) || inflateDlz(await lib.read(p))).slice();
    const ents = dldEntries(dld, info.tri, info.imgIdx);
    if (!ents.length) continue;
    for (const ent of ents) {
      // bits 0-2 = levels 0-2, bit 3 = level 3 and smaller; an entry holds every listed level it has room for
      const levels = [0, 1, 2].filter(k => ent.mips & (1 << k));
      if (ent.mips & 8) for (let k = 3; k < sizes.length; k++) levels.push(k);
      const parts = [];
      let n = 0;
      for (const lv of levels) { if (n + sizes[lv] > ent.size) break; parts.push(chain[lv]); n += sizes[lv]; }
      if (n !== ent.size) throw new Error(`DLD entry of ${ent.size} bytes does not match its mip levels (${n})`);
      dld.set(concat(parts), ent.offset);
    }
    texEdits.set(p, dld);
    written.push(p);
  }
  if (!written.length) throw new Error('no DLD entries hold this image');
  return written;
}
