// TRI: the PS2 texture groups of Metal Gear Solid 3 / Metal Gear Online (Subsistence). Little-endian.
//
// header   {u32 0, u32 width, u32 height, u32 clutHeight, u32 textureCount, u32 0, u32 imageOffset, u32 clutOffset}
// records  textureCount x 0xA0 bytes (0xC0 in "padded" files: 32 more bytes, zero in the first record at +0x20,
//          which move TEX0 from +80 to +112):
//          {f32 u, f32 v, f32 uScale, f32 vScale (fractions of the GS texture), u32 texture hash, ...,
//           u64 TEX0 at +80 (+112 padded), ...}
// data     the image and CLUT blocks are GS local memory: written as PSMCT32 rectangles 64 px wide (buffer width 1),
//          then each texture is read back through its TEX0 (TBP0 / TBW / PSM T4 or T8 / TW / TH, CLUT at CBP + CSA).
// A texture is the region (u, v, uScale, vScale) of the TW x TH GS texture; several textures share one GS texture
// (an atlas) and one CLUT block. Texture hashes repeat across TRIs, so a texture is named by (texture hash, TRI hash).
//
// GS addressing tables and the decoding steps follow otac0n/Codec's TriFile.cs (MIT licence, (c) John Gietzen).

// ---- TRI file layout -------------------------------------------------------------------------------------------

const HEADER = {
  height: 8, clutHeight: 12, textureCount: 16, imageOffset: 24, clutOffset: 28,
  size: 32,                                // records start here
};
const RECORD = {
  u: 0, v: 4, uScale: 8, vScale: 12,       // f32 fractions of the TW x TH GS texture
  textureHash: 16,                         // u32 (24-bit hash)
  size: 0xA0, sizePadded: 0xC0,            // padded records are 32 bytes longer
  tex0: 80, tex0Padded: 112,               // u64 GS TEX0 register value
};
const MAX_TEXTURES = 4096;                 // sanity limit used to reject files that are not TRIs

// ---- GS local memory ---------------------------------------------------------------------------------------------
//
// GS memory is made of 8 KiB pages (2048 32-bit words). A page holds 32 blocks of 64 words; a block holds 4 columns
// of 16 words. How pixels map to pages, blocks, columns and words depends on the pixel storage mode (PSM):
//
//   PSMCT32  page 64 x 32 px,  block  8 x 8 px,  column  8 x 2 px,  1 pixel per word
//   PSMT8    page 128 x 64 px, block 16 x 16 px, column 16 x 4 px, 4 pixels per word (one per byte)
//   PSMT4    page 128 x 128 px, block 32 x 16 px, column 32 x 4 px, 8 pixels per word (one per nibble)
//
// Addresses are counted in words; a buffer base pointer (TBP0 / CBP) is in blocks (64 words) and a buffer width
// (TBW) in units of 64 px.

const WORDS_PER_PAGE = 2048, WORDS_PER_BLOCK = 64, WORDS_PER_COLUMN = 16;

/** Block number inside a page, by block column + 8 * block row (PSMCT32 and PSMT8 share this order). */
const PSMCT32_BLOCK_ORDER = [
  0, 1, 4, 5, 16, 17, 20, 21,
  2, 3, 6, 7, 18, 19, 22, 23,
  8, 9, 12, 13, 24, 25, 28, 29,
  10, 11, 14, 15, 26, 27, 30, 31,
];
/** Block number inside a PSMT4 page, by block column + 4 * block row. */
const PSMT4_BLOCK_ORDER = [
  0, 2, 8, 10,
  1, 3, 9, 11,
  4, 6, 12, 14,
  5, 7, 13, 15,
  16, 18, 24, 26,
  17, 19, 25, 27,
  20, 22, 28, 30,
  21, 23, 29, 31,
];
/** PSMCT32: word inside a column, by pixel x + 8 * (pixel y & 1). */
const PSMCT32_COLUMN_WORD = [
  0, 1, 4, 5, 8, 9, 12, 13,
  2, 3, 6, 7, 10, 11, 14, 15,
];

// PSMT8 / PSMT4 columns: each row of pixels inside a column reads one of four word patterns. Odd columns (in y)
// use the patterns in a different order. The *_SWAPPED patterns are the same words with their two halves swapped.
const WORDS_EVEN = [0, 1, 4, 5, 8, 9, 12, 13];
const WORDS_ODD = [2, 3, 6, 7, 10, 11, 14, 15];
const WORDS_EVEN_SWAPPED = [8, 9, 12, 13, 0, 1, 4, 5];
const WORDS_ODD_SWAPPED = [10, 11, 14, 15, 2, 3, 6, 7];

/** `values` concatenated `times` times. */
const repeat = (values, times) => Array.from({ length: times }, () => values).flat();
/** Each value repeated `run` times in a row: spans([1, 2], 3) = [1, 1, 1, 2, 2, 2]. */
const spans = (values, run) => values.flatMap(v => Array(run).fill(v));
/** A column's word table: row y (of 4) uses rowPatterns[y], repeated to fill the row's `width` pixels. */
const columnWords = (rowPatterns, width) => rowPatterns.flatMap(p => repeat(p, width / p.length));

/** PSMT8: word inside a column, [column y & 1][pixel x + 16 * row]. */
const PSMT8_COLUMN_WORD = [
  columnWords([WORDS_EVEN, WORDS_ODD, WORDS_EVEN_SWAPPED, WORDS_ODD_SWAPPED], 16),
  columnWords([WORDS_EVEN_SWAPPED, WORDS_ODD_SWAPPED, WORDS_EVEN, WORDS_ODD], 16),
];
/** PSMT8: byte inside that word, by pixel x + 16 * row. Rows 0-1 use bytes 0 / 2, rows 2-3 bytes 1 / 3. */
const PSMT8_COLUMN_BYTE = [
  ...spans([0, 2], 8), ...spans([0, 2], 8),
  ...spans([1, 3], 8), ...spans([1, 3], 8),
];
/** PSMT4: word inside a column, [column y & 1][pixel x + 32 * row]. */
const PSMT4_COLUMN_WORD = [
  columnWords([WORDS_EVEN, WORDS_ODD, WORDS_EVEN_SWAPPED, WORDS_ODD_SWAPPED], 32),
  columnWords([WORDS_EVEN_SWAPPED, WORDS_ODD_SWAPPED, WORDS_EVEN, WORDS_ODD], 32),
];
/** PSMT4: nibble inside that word, by pixel x + 32 * row. Rows 0-1 use even nibbles, rows 2-3 odd ones. */
const PSMT4_COLUMN_NIBBLE = [
  ...spans([0, 2, 4, 6], 8), ...spans([0, 2, 4, 6], 8),
  ...spans([1, 3, 5, 7], 8), ...spans([1, 3, 5, 7], 8),
];

/** GS pixel storage modes (TEX0.PSM) this decoder reads; CLUTs must be PSMCT32 (TEX0.CPSM 0). */
export const PSMT8 = 0x13, PSMT4 = 0x14;
const PSMCT32 = 0;

/** Word address of PSMCT32 pixel (x, y) in a buffer at block `basePointer`, `bufferWidth` x 64 px wide. */
function addressPsmct32(basePointer, bufferWidth, x, y) {
  const page = (x >> 6) + (y >> 5) * bufferWidth;
  const px = x & 63, py = y & 31;                          // pixel inside the page
  const block = PSMCT32_BLOCK_ORDER[(px >> 3) + (py >> 3) * 8];
  const bx = px & 7, by = py & 7;                          // pixel inside the block
  const column = by >> 1;
  return basePointer * WORDS_PER_BLOCK + page * WORDS_PER_PAGE + block * WORDS_PER_BLOCK
    + column * WORDS_PER_COLUMN + PSMCT32_COLUMN_WORD[bx + (by & 1) * 8];
}

/** Uploads `rows` rows of a 64 px wide PSMCT32 rectangle (buffer 0, width 1) from `src` at `offset`. */
function uploadPsmct32(memory, rows, src, offset) {
  const words = Math.min(64 * rows, (src.length - offset) >> 2);
  const data = new DataView(src.buffer, src.byteOffset + offset, words * 4);
  for (let i = 0; i < words; i++) memory[addressPsmct32(0, 1, i & 63, i >> 6)] = data.getUint32(4 * i, true);
}

/** Palette index of PSMT8 pixel (x, y); `bufferWidth` is TEX0.TBW (64 px units). */
function readPsmt8(memory, basePointer, bufferWidth, x, y) {
  const pagesPerRow = bufferWidth >> 1;                    // PSMT8 pages are 128 px wide
  const page = (x >> 7) + (y >> 6) * pagesPerRow;
  const px = x & 127, py = y & 63;
  const block = PSMCT32_BLOCK_ORDER[(px >> 4) + (py >> 4) * 8];
  const bx = px & 15, by = py & 15;
  const column = by >> 2, row = by & 3;
  const cell = bx + row * 16;
  const word = memory[basePointer * WORDS_PER_BLOCK + page * WORDS_PER_PAGE + block * WORDS_PER_BLOCK
    + column * WORDS_PER_COLUMN + PSMT8_COLUMN_WORD[column & 1][cell]];
  return (word >>> (8 * PSMT8_COLUMN_BYTE[cell])) & 0xFF;
}

/** Palette index of PSMT4 pixel (x, y); `bufferWidth` is TEX0.TBW (64 px units). */
function readPsmt4(memory, basePointer, bufferWidth, x, y) {
  const pagesPerRow = bufferWidth >> 1;                    // PSMT4 pages are 128 px wide
  const page = (x >> 7) + (y >> 7) * pagesPerRow;
  const px = x & 127, py = y & 127;
  const block = PSMT4_BLOCK_ORDER[(px >> 5) + (py >> 4) * 4];
  const bx = px & 31, by = py & 15;
  const column = by >> 2, row = by & 3;
  const cell = bx + row * 32;
  const word = memory[basePointer * WORDS_PER_BLOCK + page * WORDS_PER_PAGE + block * WORDS_PER_BLOCK
    + column * WORDS_PER_COLUMN + PSMT4_COLUMN_WORD[column & 1][cell]];
  return (word >>> (4 * PSMT4_COLUMN_NIBBLE[cell])) & 0xF;
}

/** The TEX0 fields a texture is read with, from the register's low and high 32 bits.
 *  tbp texture base (blocks), tbw buffer width (64 px), psm pixel storage mode, tw / th texture size (px),
 *  cbp CLUT base (blocks), cpsm CLUT storage mode, csm CLUT layout (0 = CSM1), csax / csay CLUT entry offset. */
function readTex0(lo, hi) {
  const field = (word, shift, bits) => (word >>> shift) & ((1 << bits) - 1);
  return {
    tbp: field(lo, 0, 14),
    tbw: field(lo, 14, 6),
    psm: field(lo, 20, 6),
    tw: 1 << field(lo, 26, 4),
    th: 1 << (((lo >>> 30) | (hi << 2)) & 0xF),              // TH (bits 30-33) straddles the two words
    cbp: field(hi, 5, 14),
    cpsm: field(hi, 19, 4),
    csm: field(hi, 23, 1),
    csax: field(hi, 24, 1),
    csay: field(hi, 25, 4),
  };
}

/** Texture records of a TRI: [{tex, u, v, w, h (texels, fractional), gs: TEX0 fields}]. */
export function parseTri(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = at => view.getUint32(at, true), f32 = at => view.getFloat32(at, true);
  if (bytes.length < 0x40 || u32(0) !== 0) throw new Error('not a TRI');
  const count = u32(HEADER.textureCount);
  const imageOffset = u32(HEADER.imageOffset), clutOffset = u32(HEADER.clutOffset);
  if (!count || count > MAX_TEXTURES || imageOffset > bytes.length || clutOffset > bytes.length) throw new Error('not a TRI');

  // In padded files bytes 0x20..0x3F of the first record are all zero; unpadded records have data there.
  let padded = true;
  for (let k = 0; k < 8; k++) if (bytes.length >= 96 && u32(HEADER.size + 0x20 + 4 * k)) padded = false;
  const recordSize = padded ? RECORD.sizePadded : RECORD.size;
  const tex0At = padded ? RECORD.tex0Padded : RECORD.tex0;

  const records = [];
  for (let i = 0; i < count && HEADER.size + (i + 1) * recordSize <= bytes.length; i++) {
    const at = HEADER.size + i * recordSize;
    const gs = readTex0(u32(at + tex0At), u32(at + tex0At + 4));
    records.push({
      tex: u32(at + RECORD.textureHash),
      u: f32(at + RECORD.u) * gs.tw, v: f32(at + RECORD.v) * gs.th,
      w: f32(at + RECORD.uScale) * gs.tw, h: f32(at + RECORD.vScale) * gs.th,
      gs,
    });
  }
  return records;
}

/** PS2 alpha is 0..128 (128 = opaque); scale it to 0..255. */
const ps2Alpha = a => Math.min(255, Math.round(a * 255 / 128));

/** GS memory of one TRI, decoding GS textures (TW x TH RGBA) on demand. */
export class TriMemory {
  constructor(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.height = view.getUint32(HEADER.height, true);
    this.clutHeight = view.getUint32(HEADER.clutHeight, true);
    // large enough for the uploaded rows, and at least one page
    const wordsFor = rows => Math.max(WORDS_PER_PAGE, addressPsmct32(0, 1, 63, Math.max(0, rows - 1)) + WORDS_PER_PAGE);
    this.image = new Uint32Array(wordsFor(this.height));
    this.clut = new Uint32Array(wordsFor(this.clutHeight));
    uploadPsmct32(this.image, this.height, bytes, view.getUint32(HEADER.imageOffset, true));
    uploadPsmct32(this.clut, this.clutHeight, bytes, view.getUint32(HEADER.clutOffset, true));
  }

  /** RGBA palette of a texture: CT32 entries, 16 x 16 (T8) or 8 x 2 (T4) at CBP, offset by CSA. */
  palette(gs, bits) {
    const [columns, rows] = bits === 8 ? [16, 16] : [8, 2];
    let entries = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const at = addressPsmct32(gs.cbp, 1, gs.csax * 8 + x, gs.csay * 2 + y);
      entries.push(at < this.clut.length ? this.clut[at] : 0);
    }
    if (bits === 8 && !gs.csm) {
      // CSM1 stores the 256 entries in 8-entry runs; runs 1 and 2 of every 4 are swapped (8..15 <-> 16..23, ...)
      const swapped = entries.slice();
      for (let run = 1; run <= 29; run += 4) {
        for (let k = 0; k < 8; k++) {
          swapped[run * 8 + k] = entries[(run + 1) * 8 + k];
          swapped[(run + 1) * 8 + k] = entries[run * 8 + k];
        }
      }
      entries = swapped;
    }
    const rgba = new Uint8Array(entries.length * 4);
    entries.forEach((color, i) => {
      rgba[4 * i] = color & 0xFF;
      rgba[4 * i + 1] = (color >>> 8) & 0xFF;
      rgba[4 * i + 2] = (color >>> 16) & 0xFF;
      rgba[4 * i + 3] = ps2Alpha((color >>> 24) & 0xFF);
    });
    return rgba;
  }

  /** RGBA of the whole TW x TH GS texture a record points at (null for formats other than T4 / T8). */
  decode(gs) {
    const bits = gs.psm === PSMT8 ? 8 : gs.psm === PSMT4 ? 4 : 0;
    if (!bits || gs.cpsm !== PSMCT32) return null;
    const palette = this.palette(gs, bits);
    const readIndex = bits === 8 ? readPsmt8 : readPsmt4;
    const { tw, th } = gs, out = new Uint8Array(tw * th * 4);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const o = (y * tw + x) * 4;
        const p = readIndex(this.image, gs.tbp, gs.tbw, x, y) * 4;   // pixels outside the uploaded data read index 0
        out[o] = palette[p]; out[o + 1] = palette[p + 1]; out[o + 2] = palette[p + 2]; out[o + 3] = palette[p + 3];
      }
    }
    return out;
  }
}

/** Key a TRI texture is looked up by: texture hash and TRI hash (both 24-bit), as tri << 24 | tex. */
export const triTexKey = (tex, tri) => tri * 0x1000000 + tex;
