# LA2 format reference

LA2 is the 2D layout and animation format of *libla*, the interface library of the MGS4 engine (Metal Gear Solid 4,
Metal Gear Online 2, Metal Gear Arcade). This document describes the format as Libla Studio reads and writes it, then
the PS2 version (MGS3 / MGO1, and MGS3's PS3 HD port) and Peace Walker's LA3.
Structure names follow the engine's own naming where it is known.

## Conventions

- **Byte order:** big-endian on PS3. Metal Gear Arcade's LA2 files are also big-endian (its archives and textures
  are little-endian). Metal Gear Solid 3 / Metal Gear Online (PS2) files are little-endian. A reader detects the
  order from the version field.
- **Units:** positions and sizes are in 1/16 pixel; rotation uses 4096 per full turn; scale uses 256 = 1.0;
  colours are RGBA bytes: RGB 0..255, alpha 0x80 = opaque (doubled and clamped when drawn).
- **Names** (objects, actions, layers, textures, commands) are 24-bit string hashes:
  `x = ((x << 5) | (x >> 19)) & 0xFFFFFF; x = (x + byte) & 0xFFFFFF` for each byte.

## Header (`tagLA2_HEADER`)

`u32 version` (`0x00010008` or `0x00010009`; `0x00010007` on PS2), then 12 `u32` section offsets (11 on PS2, which
has no layer table):

| # | Section | Contents |
|---|---|---|
| 0 | ofObj | object definitions |
| 1 | ofStat | status blocks |
| 2 | ofAct | actions |
| 3 | ofActTbl | action table (hash → action offset, sorted by hash) |
| 4 | ofTri | TRI (texture group) hashes |
| 5 | ofKeyName | key names (unused in shipped files) |
| 6 | ofTexTbl | texture table |
| 7 | ofColorTbl | colour table |
| 8 | ofUVTbl | UV table |
| 9 | ofCtrlVtTbl | control-vertex table |
| 10 | ofFont | fonts |
| 11 | ofLayer | layers |

Sections are 4-byte aligned. Metal Gear Arcade and MGO2 store TRI first; MGS4 slot files store it after the action
table.

## Objects

`tagLA2_OBJ_DEF_HEADER` — 22 `u16` counts the engine sizes its memory with: usObjectCount, usVertexCount
(LineStrip + TriangleStrip vertices), usUnitCount (TriangleStrip units), usMatrixCount, usBaseColorCount,
usTexCount, usLoadTRICount, usAlphaRegCount, usCallCount, then one count per object type (usEmptyCount, usCtrlCount,
usBoxCount, usSprtCount, usRsprtCount, usTriangleCount, usQuadCount, usLineCount, usLineStripCount,
usTriangleStripCount, usStringCount, usTypingCount) and usPad.

`tagLA2_OBJECT` (20 bytes, then `unitCount × {u16 unit, u16 vertexCount}`):

| Field | Type | Meaning |
|---|---|---|
| strcode | u32 | name hash |
| type | u32 | low nibble = object type; flag bits above (0x10000 matrix, 0x20000 size, 0x40000 textured, 0x80000 string, 0x1000000 / 0x2000000 alpha-register / base-colour slots) |
| id | u16 | object id (1…N; the engine indexes objects by id) |
| parentID | u16 | parent object id (0 = root) |
| viewNextObjectID | u16 | id of the next object after this subtree (next sibling, else an ancestor's next sibling, else 0) |
| vertexCount | u16 | vertices |
| unitCount | u16 | units (TriangleStrip) |
| layerIndex | u16 | layer |

Retail libla (MGO2, Metal Gear Arcade 2011 and 2015) dispatches on the **low 4 bits** of the type word; an MGS4 PS3
debug build checks the whole low byte and rejects anything above 11. MGS4's Flash-converted layouts mark shapes with
extra bits there (for example `0x3016`: a Quad with bits 0x10, 0x1000, 0x2000). Those are Flash mask / guide shapes:
drawn, they cover the scene with flat shapes, so Libla Studio hides them unless asked to show them (how retail MGS4
skips them is not traced). In MGA's libla, 0x1000 / 0x2000 / 0x4000 make the object's draw packet rebuild every
update.

The Flash-converted movies (`slotdat/slot_flash`) are authored on a 320 × 180 px stage (5120 × 2880 units) that the
game draws full screen; most start with a stage-sized Quad or RSprt at the origin.

### Object types

| Type | Name | Drawn as | Colours |
|---|---|---|---|
| 0 | Nul | group: children inherit position, rotation, scale, colour | — |
| 1 | Ctrl | group with control vertices | — |
| 2 | Box | untextured rectangle (xy + wh) | one |
| 3 | Sprt | textured rectangle (xy + wh + uv) | one |
| 4 | RSprt | textured quad (4 points) | one |
| 5 | Triangle | 3 points | per vertex |
| 6 | Quad | 4 points | per vertex |
| 7 | Line | 2 points, 1 px line | per vertex |
| 8 | LineStrip | n points, 1 px lines | per vertex |
| 9 | TriangleStrip | one triangle fan per unit | per vertex, per unit |
| 10 | String | text | one |
| 11 | Typing | text revealed letter by letter | first / end colour |

## Status blocks and packets

`u32 count`, then blocks `{u16 packetCount, u16 size, packets}`; packet `{u16 type, u16 size, data}`, ending with
type 0. Blocks `0 … objects − 1` are the objects' initial states; later blocks are targets of action keys.

| Type | Name | Data |
|---|---|---|
| 0 | end | — |
| 1 / 2 | show / hide | — |
| 3 | xy | `u32 lists; {u16 count, u16 tag, count × (s16 x, s16 y)}` |
| 4 | xy_add | as xy, added |
| 5 | wh | `u32 n; n × (s16 w, s16 h)` |
| 6 | rgba | `u32 n; n × (u16 target unit, u16 colour index | mask << 12)` — mask bits 8/4/2/1 = R/G/B/A |
| 7 | texture | `u32` texture-table index (1-based) |
| 8 | uv | `u32` UV-table index |
| 9 | blend | `u32`: 0x1010 normal, 0x1020 add, 0x2001 subtract, 0x22 none |
| 10 | scale | `u32` (low 16 bits; 256 = 1.0) |
| 11 | rotate | `s16` (4096 = full turn) |
| 12 | spin_center | ignored by the engine |
| 13 | text | `u32 length; bytes; NUL; padding` |
| 14 | string_space | `s16` letter spacing |
| 15 | name | — |
| 16 | ctrl_vertex | control vertices |
| 17 | typing_mode | `s16`: 0 off, 1 typing, 3 first colour, 4 end colour |
| 18 | font | `s16` font id (1-based) |
| 19 | string_pos_mode | `s16` alignment |
| 20 / 21 | typing_speed / typing_color_speed | `s16` ticks |
| 22 / 23 | typing_first_color / typing_end_color | `u32` RGBA |
| 24 | string_init_data | `s16 space, s16 mode (0 left, 1 right, 2 centre, 3 justify), s16 font id` |
| 25 | typing_init_data | `s16 typeSpeed, s16 colorSpeed, u32 firstColor, u32 endColor` |

A colour-table entry holds one colour per vertex (a Quad's entry has 4 colours, a Line's 2); an rgba packet's target
selects the unit (TriangleStrip).

## Actions and keys

`u32 count`; action `{u16 tracks, u16 flags, u16 size, u16 ?}`; track `{u16 object id, u16 keys, u32 size}`;
key `{u16 type, u16 size, data}`.

- `flags` ≠ 0: the action loops. An action can also be looped by the command that starts it.
- `size` is 16-bit and not used by the engine; in large files it wraps or is stale. The end of the last track is the
  end of the action.

| Key | Name | Data | Meaning |
|---|---|---|---|
| 0 | end | — | end of track |
| 1 | commands | `u32 n; n × (u32 command hash, u32 argument)` | see below |
| 2 | call | `u32` action hash | run another action's first track inline (up to its return) |
| 3 | return | — | end of a called track |
| 4 | wait | `u32` ticks | hold |
| 7 | set | `u32` status-block file offset | apply a block at once |
| 8 | morph | `u32 ticks, u32` status-block offset | interpolate to a block over n ticks |

Morph progress is `(now − start) / ticks`, clamped to 0…1, interpolating positions, sizes, colours, scale and
rotation from the values the object had when the key began: `(1 − rate)·from + rate·to` in single precision, rounded
half away from zero to whole units (MorphFuncVertex, MorphFuncRGBA, …). Every other change (show / hide, blend,
texture, text, font, typing settings) applies when the progress reaches one; rotate acts on Nul objects only.
Retail's morph loop applies every packet of the block whatever each handler returns (an MGS4 debug build stops at
the first handler that returns −1). Status offsets may point inside a block (the packets from that point apply).

### Time and playback (libla)

Durations are **ticks of 1/300 s**. Each game update advances every playing action by `round(speed × K)` ticks, where
K is the game's elapsed time (`round(0.3 × ms)`, so 5 at 60 fps) and the speed is chosen by the code that drives the
layout (1.0 for MGO2's lobby rule screen). Actions are only ever evaluated at these steps.

Playing actions form a list in start order; each update advances them in turn and runs every key it reaches. Loading
a layout starts nothing: the game's code starts actions (by hash, optionally looping, reversed, or on another object)
or queues them to start when another ends, and commands inside the file start more. A screen is therefore often
several actions at once that only the game's code combines (MGO2's lobby rule screen keeps #2b7872, the soldiers' run
cycle, and #925b6e, the goals, looping under every rule's action).

- Starting an action that is already playing does nothing.
- An action started by a command is appended and advanced in the same update, so it begins one step before that
  update on the game's grid.
- An action ends in the first update in which every track has reached its end; it is then removed (non-looping) or
  restarts at tick 0 in the next update (looping: the action header's flag, or a loop start). A pass therefore lasts
  `ceil(length / step) × step` ticks.

### Commands

| Command | Argument | Effect |
|---|---|---|
| StartAction | action hash | start an action alongside the current one (ignored while it is playing) |
| StartLoopAction | action hash | start an action, looping |
| StopAction | action hash | stop an action |
| FrontLayer / BackLayer | layer hash or 0 | move the track object's layer just in front of / behind another layer (or the frontmost / backmost); the layers between shift by one. A layer already on that side only takes the neighbouring priority. |
| SwapLayer | layer hash | swap two layers' priorities |
| OffLayer | — | turn the track object's layer off |
| #f286b2 | — | turn it back on (name unknown) |
| Name, #173f76 | — | ignored |

Any other command hash is passed to the game as a signal.

## Drawing

1. Layers are drawn by priority (initially their index); a layer whose status has bit 0 set is not drawn.
2. Within a layer, objects are drawn in file order.
3. A child's position is rotated and scaled by its parent's matrix; rotations add, scales and colours multiply.
4. Blend modes: normal `src·a + dst·(1−a)`, add `src·a + dst`, subtract `dst − src·a`, none = opaque.
5. Textures: UVs are kept in 1/16 texel; SetPacketSprt / SetPacketRSprt / SetPacketString move each UV 4 units
   (a quarter texel) toward the middle of the object's UV rectangle (TriangleStrip UVs are used as they are).
6. Text: glyphs are drawn at their font-cell size (1/16 px); x advances by each glyph's width; a line ends at
   `\n`, `\r` or their two-character escapes and moves down by the newline glyph's height; each line is aligned by
   the string's mode within its box width, with `space` added between letters (justify spreads them).
7. Typing: in mode 1 one letter appears every *typeSpeed* ticks after the mode was set, each fading from the first
   to the end colour over *colorSpeed* ticks.
8. Runtime text fields: text the game writes while it runs (MGS3 item descriptions and dialogs, MGO1 / MGO2 player
   names, ...) is reserved as a string of only `@` (and line breaks) in a font whose `@` cell is a square taken from
   the top-left of its texture, a sheet of box frames. `@` never appears in real text in these fonts, and the game
   never shows the boxes: Libla Studio leaves them out unless Settings → Draw runtime text fields is ticked
   (819 such strings in MGS3 / MGO1 layouts, 445 in MGO2's r_sna01_n).

## Tables

- **Texture table:** `u32 n; n × (u32 texture hash, u32 TRI hash)`; objects refer to entries 1-based.
- **Colour table:** `u32 n; n × {u16 count, u16 size, count × RGBA}`.
- **UV table:** `u32 n; n × {u16 count, u16 size, count × (u16 u, u16 v)}` in texture pixels (version 0x10009: relative
  to the texture's region in its atlas).
- **Fonts:** `u32 n; {u32 hash, u16 cells, u16 size, cells × {u16 w, u16 h, u16 u0, u16 u1, u16 v0, u16 v1, char[4]}}`;
  UVs are 0…65535 of the font texture.
- **Layers** (`tagLA2_LAYER`): `u32 n; n × (u32 strcode, u16 status, u16 objectCount)`; an object's layer is its
  layerIndex.

## Containers and textures

- **DAR:** `u32 count`; per file: name, NUL, padded to 4; `u32 size`; data aligned to 16; one NUL.
- **QAR:** concatenated files, then `{u16 count, u16 pad, count × (u32 info, u32 size)}` and names; the last `u32` of
  the file is the header offset.
- **DLZ:** `segs` segments of raw-deflate chunks (0x4000 bytes of input each) decompressing to a DLD.
- **TXN:** image records `{u16 w, u16 h, u16 format (9 DXT1, 10 DXT3, 11 DXT5), u16 flag, u32 data, u32 end}` and
  texture records (0x30 bytes: hash, TRI hash, region w / h / x / y, image). A texture is a region of an image.
  Without DLZ data (some MGS4 slots) the pixels are stored in the TXN at `[data, end)`.
- **DLD:** entries `{u8 type, u8 priority, …, u32 TRI hash, …, u32 size, u32 mip mask, u32 image index, …}` and data.
  Priority 0 holds the full-size image; others hold smaller mip levels.

## MGO2 stage-file encryption

MGO2's stage archives are encrypted with a key derived from their folder below `USRDIR/o`, written
`stage/<name>` (for both `o/stage/<name>` and `o/dl/p/stage/<name>`): a 64-bit XOR chain over the data followed by a
16-byte MD5-based checksum. Libla Studio decrypts such files when reading and re-encrypts archives it writes.

## PS2: Metal Gear Solid 3 / Metal Gear Online (version 0x10007)

(See the end of this section for the PS3 HD port.)

The PS2 libla writes the same structures little-endian, with these differences:

- The header has 11 section offsets (no `ofLayer`); every object is on layer 0.
- **UV table** and font UVs are 0…65535 across the texture's region (MGS4: texels). The region already samples
  texel centres, so no quarter-texel inset applies.
- **Texture table** pairs `(texture hash, TRI hash)`; texture hashes repeat across TRIs (often at different places),
  so a texture is identified by both.
- Textures live in **TRI** files (`<TRI hash>.tri`, loose in a stage folder):
  header `{u32 0, u32 width, u32 height, u32 clutHeight, u32 count, u32 0, u32 imageOffset, u32 clutOffset}`;
  `count` records of 0xA0 bytes (0xC0 when 32 zero bytes follow the hash):
  `{f32 u, f32 v, f32 uScale, f32 vScale, u32 texture hash, …, u64 TEX0 at +80 (+112)}`, the GS registers that
  select the texture. The image and CLUT blocks are GS local memory: written as PSMCT32 rectangles 64 px wide
  (buffer width 1), each texture is read back as PSMT4 / PSMT8 through its TEX0 (TBP0, TBW, TW, TH; CLUT CT32 at
  CBP + CSA, CSM1 entry swizzle for 8-bit; alpha 0x80 = opaque). A texture is the (u, v, uScale, vScale) region,
  in fractions of the TW × TH GS texture, which several textures share. Decoding follows otac0n/Codec's
  `TriFile.cs` (MIT).


### PS3 HD port of Metal Gear Solid 3

Same layout format (version 0x10007, little-endian), in `mgs3/<lang>/stage/<name>/cache` and `mgs3/<lang>/slot/…`,
named with 8 hex digits (`00fdea15.tri`). Differences:

- Bit 28 of the first header offset (`ofObj | 0x10000000`) marks layouts redone in 1280×720 coordinates; the others
  keep PS2 coordinates. Mask it off to get the offset.
- The `.tri` files keep their records but their image and CLUT blocks are all zeros. Each texture is instead
  `<texture hash>[-name].ctxr`, found in the layout folder, its `_ps3` subfolder, or the language-neutral
  `mgs3/stage/<name>/cache/_ps3` (most specific first). One CTXR is one TRI region: the whole texels from
  `floor(u)` to `u + w + frac(u)` (the region is texel-centred), redrawn at any size, not always uniformly scaled
  (a 511×399 region becomes 1280×720). Records with an empty region are PS3-only textures that use the whole CTXR.
- Many layouts reference TRIs that the port does not ship in their language folder (e.g. `ce43e2`, only under
  `sp/`); their CTXRs are still beside the layout, so textures are looked up by texture hash, using the whole CTXR.
- **CTXR** is a GTF-like texture, big-endian: `{u32 0x02000101, u32 data size, u32 1, u32 id, u32 data offset (0x80),
  u32 data size}`, then either `+0x18 {u8 format, u8 mipmaps, u8 dimension, u8 cubemap, u32 remap, u16 w, u16 h,
  u32 depth}` (it repeats remap / w / h at +0x28) or (most stage textures) three unknown words at +0x18 and `{format, mipmaps, dimension, cubemap}` at
  +0x24; both continue `+0x28 u32 remap, +0x2C u16 width, u16 height, +0x30 u32 depth, +0x34 u32 pitch`.
  Formats are `CELL_GCM_TEXTURE_*`: 0x85 A8R8G8B8 (bytes A R G B), 0x9E D8R8G8B8 (opaque), 0x86–0x88 DXT1/3/5;
  flag 0x20 = linear rows of `pitch` bytes, otherwise RSX-swizzled (Morton order). Alpha keeps the PS2 scale
  (0x80 = opaque).

## Peace Walker: LA3 (`.la3`) and TXP (`.txp`)

*Metal Gear Solid: Peace Walker* (PSP; read here from the PS3 HD port, `NPUB30611`, whose files stay
little-endian and are byte-swapped by the game on load, EBOOT `sub_C00B5C`) uses **LA3**, libla's successor: the same
object types and the same ideas (status, set / morph / wait keys, 300 ticks per second), packed into chunks. LA2
Studio reads LA3 and converts it into an LA2 in memory, so it is viewed and played by the same engine; LA3 files are
view-only. The container was read from files and the PS3 EBOOT's byte-order routines; playback was checked by
static analysis of the decrypted PSP EBOOT. Names below are descriptive names, not recovered symbols.
See [LA3 runtime evidence and remaining limits](LA3_RUNTIME.md).

Where: `disc0_rel/stage/<name>/` (`cache.dar` / `resident.dar` hold the `.la3` files, `cache<N>.qar` /
`resident<N>.qar` the `.txp` textures) and `SLOT.DAT` (each slot holds loose `.la3` and `.txp`). As shipped, the
stage folders are packed in `STAGEDAT.PDT` (see [Packed game data](#packed-game-data)), which Libla Studio reads in place.

**Header** (16 bytes): `"FEL"` + version byte (4, 5 or 7; all three are read), `u32 0`,
`u16`, `u16 0x0404`, `u32 300` (ticks per second).

**Chunks** follow: `{u8 type, u24 size}` + `size` bytes, until type 0. Index sections start with
`{u16 count, u16 x}`; their paired data sections have the contents shown below, without a universal header.

| Type | Contents |
|---|---|
| 0x20 | objects: `count` × `u16` offset into 0x21 |
| 0x21 | object `{u16 id, u16 parent (0xFFFF = none), u32 name hash, u32 type (low nibble = LA2 object type, high bits flags), u32 mask, u32 ?}`, then one 16-bit value per set mask bit (lowest bit first): the initial state |
| 0x40 | action records, 16 bytes: `{u32 hash, u32 object name hash, u32 length (ticks), u16 key count, u16 first}` into 0x41. Each record animates one object; records whose hashes share the low 24 bits (the high byte numbers them 1, 2, …) form one action |
| 0x41 | `u16` key numbers (into 0x50) |
| 0x50 | `count` × `u32` offset into 0x51 |
| 0x51 | key `{u16 type, u16 size, …}`: 0 end · 1 set `{u32 mask, values}` · 2 morph `{u32 ticks, u32 mask, values}` · 3 wait `{u32 ticks}` · 4 game callbacks, `u32` pairs `(command, argument)` · 5 start action `{u32 action hash, u32 target object hash}` |
| 0x80 | textures: `{u16 count, u16 hash count}`, then `count` × `{u8 texture-hash index, u8 TXP-hash index}` (`u16`s from version 6 onward when there are 256 or more hashes; versions 4/5 keep byte indices) |
| 0x81 | the hashes, `u32`, sorted |
| 0x90 | point lists into 0x91: versions 4/5 use `count` × `{u16 points, u16 first}`; version 7 uses `{u8 points, u8 first-high, u16 first-low}`, with a 24-bit first-point index |
| 0x91 | points `{i16 x, i16 y}`: positions and sizes in 1/16 px, UVs in 1/16 texel |
| 0xA0 / 0xA1 | colour lists `{u16 colours, u16 first}` into `{u8 r, g, b, a}` (alpha 0x80 = opaque, as LA2) |
| 0xC0 / 0xC1 | texts `{u16 length, u16 offset}` into the text bytes |
| 0xD0 / 0xD1 | fonts `{u32 hash, u16 glyphs, u16 first}` into glyphs `{u32 code, u16 size list, u16 UV list}`: the size list holds the cell (w, h in 1/16 px), the UV list its two corners |
| 0xB0 / 0xB1 | control-vertex lists `{u16 count, u16 first}` into byte indices; these bind vertices to a Ctrl ancestor's point list |

**Mask bits** (object state and set / morph keys): 2 visible · 4 position list · 5 colour list · 6 size list
(Box, Sprt, String) · 7 UV list · 9 control-vertex list · 10 String spacing list · 11 text · 16 rotation
(65536 units per turn, negated for drawing) · 17 signed scale (256 = 1.0) · 18 blend (0 normal, 1 additive,
2 destination minus source, other values disable blending) · 19 texture · 20 stencil write mask · 28 stencil
test mask · 22 font · 23 alignment (0 left, 1 right, 2 centre); 12, 13, 24…27 Typing only.

Normal point properties (position, size, UV and spacing), scale and colour interpolate with rounding by the
direction of change. The game can select an alternate snapshot-based point handler with an instance flag;
that mode is not specified by the file and is not emulated. Rotation interpolates over the shortest 16-bit arc. Discrete
properties such as visibility, blend mode and texture change only at the end of a morph. Type-4 messages call
the application's callback; their numbers do not name universal LA3 commands. Type 5 selects all tracks sharing
an action's low 24-bit hash, or one exact track when the hash has a nonzero high byte, and starts them on its
specified object without looping. Studio does not yet reproduce control-vertex bindings or stencil clipping.

Layout coordinates are PSP-screen sized (480 × 272); many layouts start hidden and are shown by their actions.
Text made only of `@` reserves room for text the game writes at run time (hidden unless placeholders are shown).

**UVs** (sprites and glyphs) are in 1/16 texel of the texture's own layout size (`w` × `h` in the TXP), mapped
through its rectangle into the image's power-of-two buffer. In decoded-image pixels,
`U = (texture.u + (layoutU / 16 / texture.w) * texture.uw) * image.bw`, and similarly for V. The DDS's stored
dimensions can include padding: a 32 × 32 buffer can live in a 32 × 128 DDS, while UVs still address 32 rows.
The PS3 texture binder (`sub_2D6F8` → `sub_C51020` → `sub_C2018C`) passes the buffer exponents; shader setup
`sub_C20F60` scales the texture transform by buffer dimensions divided by actual GPU dimensions. Layouts keep
their own distance from the edges (no quarter-texel inset).

**TXP** (little-endian):

- header `{u32 flags, u32 own hash, u32 image count, u32 texture count, u32 ?, u32 image table (0x20), u32 texture
  table, u32 data start}`. Flags 0: paletted pixels inside the file; 1: DDS inside the file (the HD port's
  UI textures); 2: pixels held elsewhere (model / effect textures; not decoded).
- image, 20 bytes: `{u16 format, u16 width, u16 height, u16 0, u32 0, u32 pixel offset, u32 0}`; width and height
  are `log2(buffer size) << 12 | size`. Format (low 3 bits) 4: 4-bit indices, 5: 8-bit indices, both PSP-swizzled
  (16-byte × 8-row blocks) with an RGBA8888 palette (full 0…255 alpha); 6: a DDS (DXT1 / DXT5) at the texture's
  palette offset.
- texture, 40 bytes: `{u32 flags, u32 hash, u32 image record offset, u32 palette (or DDS) offset, f32 u, f32 v,
  f32 width, f32 height (fractions of the power-of-two image buffer, excluding DDS padding), u16 width,
  u16 height (layout texels), u32 ?}`. Layouts name a
  texture by (texture hash, TXP hash).

### Portable Ops (PSP): LA2 version 8 and its TXPs

*Metal Gear Solid: Portable Ops* layouts are ordinary little-endian LA2 version `0x10008` files (the same header as
Metal Gear Arcade's), inside each stage's `_zar` (`cache.dar`; textures in `cache.qar`) and in `slot.dat` (loose
`.la2` and `.txp`; see [Packed game data](#packed-game-data)). Two things differ from MGA:

- the texture table pairs are (texture hash, TXP hash), and the TXP hash is StrCode24 of the TXP's file name (its
  QAR id); a texture is looked up by both, like the PS2 TRI textures;
- UVs and glyph UVs are 0…65535 of the texture's region (as on PS2), not texels; no quarter-texel inset.

The header cannot tell Portable Ops from MGA, so Libla Studio decides from the textures: a version-8 LE layout whose
texture table resolves to (texture, TXP) keys of the folder's TXPs is read as Portable Ops.

**Portable Ops TXP** (little-endian; no hash of its own):

- header `{u32 0, u32 flags, u32 image count, u32 image table (0x20), u32 texture count, u32 texture table,
  u32 0, u32 0}`.
- image, 16 bytes: `{u16 width, u16 height (log2(buffer) << 12 | size), u16 format (4: 4-bit, 5: 8-bit indices),
  u16 flags (2: zlib-compressed pixels: u32 compressed size, then a zlib stream), u32 pixel offset, u32 palette
  offset}`. The palette is RGBA8888 with full 0…255 alpha. Pixels are PSP-swizzled (16-byte × 8-row blocks) with
  the **visible** width as the stride, `width × height` of them (not the power-of-two buffer).
- texture, 48 bytes: `{u32 flags, u32 hash, u32 0, u16 width, u16 height (layout texels), u32 0, u32 image record
  offset, u32 0, f32 u, f32 v, f32 width, f32 height, u32 0}`; u / v / width / height are fractions of the buffer,
  texel-centred (`u = 0.5 / buffer width` for a texture that starts at the left edge).

All 526 distinct Portable Ops TXPs (7,461 images) use these formats.

**PW QAR** (`*.qar`, little-endian): the files at 0x1000 boundaries, then (at the offset in the last `u32`)
`{u32 count, count × (u32 id = StrCode24(name) | type << 24, u32 size)}` and the names, NUL-terminated, in the same
order. (Tools that pack the files back to back instead cut every file but the first wrongly.) **Portable Ops QAR**
is the same with the files at 0x80 boundaries. **PW DAR** is the
MGS4 DAR layout, little-endian. StrCode24: `x = ((x << 5 | x >> 19) + c) & 0xFFFFFF` over the name's bytes.

## Packed game data

How each game packs its stages and slots, as Libla Studio reads them in place (`js/formats/packs.js`). Every cipher
here XORs little-endian 32-bit words with a key stream `key = key * 0x02E90EDD + step`. Files stored by id are
`type << 24 | StrCode24(name)`.

**MGS3 / MGO1 (PS2) `STAGE*.DAT`** (MGS3_N.ELF `sub_1012F0` / `sub_1013B8` / `sub_101810` / `sub_100D80`): `u32 w0`,
then encrypted with key `w0`, step `w0 ^ 0xF0F0`: 12 header bytes (`s16` stage count at +4) and count ×
`{char name[16], u32 sector}` (sectors of 0x800). Each stage starts with a TOC encrypted with
`key = StrCode(name) * 129 + w0 + 0xA78925D9`, `step = StrCode(name) * 129 + 0x7A88FB59`: `u32 n`, n × `{u32 a, u32 b}`,
padded to 0x800. `7F0000xx` opens a section of size b, `7E` + 24-bit compressed size gives its offset b after the
TOC, other entries are files at offset b in the section, `7F000000` closes it. A section is a zlib stream encrypted
with `k = first u16 ^ 0x9385`: key `(k ^ 0x6576) << 16 | k`, step `k * 0x116`; after decryption the first u16 gets
`+ 0x8F3` (giving the `78 9C` zlib header). Section `7F000010` is the stage's sound bank, streamed raw.

**Plain slots: MGS3 / MGO1 `SLOT*.DAT`, Portable Ops `slot.dat`:** `{u32 stamp, u16 1, u16 sector multiple,
u16 slot count, …}`, the rest of the first sector unused; then each slot in sequence: a stage-style TOC (not
encrypted) and its uncompressed sections, each padded to the sector. Slots have no names. Portable Ops slots hold
TXP textures (type `0x14`) and its own types (Peace Walker's table below).

**Portable Ops `stage/<name>/_zar`:** `u32 size`, then a zlib stream of a DAR holding the stage's files
(`data.cnf`, `cache.dar`, `cache.qar`, `scenerio.gcx`, …).

**Peace Walker HD `STAGEDAT.PDT`** (as in [Chrysalis](https://github.com/Jayveer/Chrysalis)): `{u32 saltA, saltB,
saltC}`, then encrypted with `v = saltA ^ saltB`, key `v | (v ^ 0x6576) << 16`, step `v * saltC`: 20 header bytes
(`u16` entry count at +12), count × `{u32 size, u32, u32 offset}` and count × `{i32 key, u32 index, u32 lt, u32 gt}`,
a binary search tree (child = value / 16; `lt` when the node's key is less than the wanted one, signed). An entry is
encrypted with the same key from its start: `u32 size` + zlib. A stage's file is found by
`key = ~((s >> 4 ^ s << 4) ^ 0x10EA) ^ id` with `s = StrCode24(stage)`; stage names are not stored, but every stage
has a `data.cnf` listing its files (lines starting with `.` are flags, `@` marks a QAR, `?` an AFP), so the stages
are the entries whose key is a `data.cnf` key for some `s` (the relation inverts), named by the file in their config
whose StrCode24 is `s` (`<stage>.rlc`).

**Peace Walker HD `SLOT.DAT` + `SLOT.KEY`:** `SLOT.KEY` holds the salts and 20-byte records `{u32 A, u32 B,
u32 hash, u32, u32}`: a slot covers sectors `A & 0xFFFFF` to `B & 0xFFFFF` (0x1000 bytes) of `SLOT.DAT`, encrypted
from its start like a `STAGEDAT.PDT` entry: `{u32 0x00100004, 0, u32 compressed size, u32 size}` + zlib. Inside:
`{u32 count, 0}` and 16-byte records `{u32 id, 0, u32 offset, 0}` up to `7F000000`; file data from 0x1000.
Peace Walker file types (EBOOT table at 0x11AD228): `0x14` txp, `0x5E` la3, `0x5F` la2, `0xF0` dar, `0xF1` qar,
`0xF2` cnf, `0x02` gcx, `0x03` tri, …

**MGS3 HD `.psarc`:** big-endian `{'PSAR', u16 1, u16 4, 'zlib', u32 TOC length, u32 30, u32 files, u32 block size,
u32 flags}`; entries `{md5[16], u32 first block, u40 size, u40 offset}`, then a compressed size per block (`u16`
for 64 KiB blocks; 0 = a full raw block, a size equal to the block's plain size = stored raw). Entry 0 is the
manifest, the other entries' paths one per line.

