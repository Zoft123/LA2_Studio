# LA2 Studio

**View, play, edit and export LA2 layouts — the animated 2D interface files of the MGS4 engine — right in your browser.**

LA2 is the layout and animation format of *libla*, the 2D library of the engine behind **Metal Gear Solid 4**,
**Metal Gear Online 2** and **Metal Gear Arcade**. Every HUD, menu, icon, loading screen and telop in those games is
an LA2 file: a tree of sprites, shapes and text with keyframed actions. LA2 Studio renders them the way the game
does, plays their animations, lets you edit them structurally, swaps their textures, and exports animations as
WebP or APNG.

**[Open LA2 Studio →](https://zoft123.github.io/LA2_Studio/)**

Everything runs locally in your browser. You pick a folder of game files you own; nothing is uploaded, and no game
data is included in this repository.

---

## What it's for

- **HUD and menu modding.** Inspect how a screen is built, move or recolour elements, change text, add new shapes,
  swap textures, and write the result back into the game's own `.dar` / `.dlz` archives (re-encrypted for MGO2).
- **Translation and text work.** Edit strings of any length; the file is rebuilt with every size and offset fixed up.
- **Research and documentation.** See object trees, status packets, action keys, command timelines and the raw
  file structure with libla's own field names.
- **Previews and archival.** Export any action as a lossless animated WebP or APNG, or save single frames as PNG.

## Features

### Viewing and playback
- Renders layouts with WebGL using the engine's rules: parent transforms (position, rotation, scale, colour),
  per-vertex colour gradients, the four blend modes (normal, additive, subtractive, opaque), 1 px lines, triangle
  fans, layer priorities and draw order.
- All object types: groups (Nul / Ctrl), Box, Sprt, RSprt, Triangle, Quad, Line, LineStrip, TriangleStrip,
  String and Typing (typewriter text with its reveal and colour fade).
- Text laid out like the game: font-cell glyph sizes, multi-line strings, left / right / centre / justified.
- Mask / guide shapes in MGS4's Flash-converted layouts, which the game never draws, are hidden (they can be shown
  from Settings).
- Playback that follows the game's engine (libla): 300 ticks per second, updates in game-frame steps, actions started
  by commands on the same update grid, starts of already-playing actions ignored, layer commands with the engine's
  priority rules. Speed 0.1×–2×, loop, once and ping-pong modes, tick stepping and scrubbing.
- **Also play:** run other actions alongside the selected one, looping, for screens the game builds from several
  actions at once. MGO2's lobby rule screen (`rule_anime.la2`) gets the game's own pair by default: the soldiers'
  run cycle and trails (#2b7872) and the goals (#925b6e) keep looping under every rule's action, which only moves
  the soldiers and switches their poses.
- The view covers everything an action shows, including objects that move outside the layout's starting area.
- Crop the live view and all exports by dragging an area or entering an exact rectangle. Crop settings stay
  with each layout during the session and do not alter the game's LA2 data.
- **Command timeline:** actions that start, loop or stop other actions and reorder layers are simulated, so
  composite screens play as a whole; fired commands are listed and clickable.
- Incremental playback with snapshots: even MGS4 layouts with millions of keyframes seek instantly.

### Weapon Select preview (MGO2 / MGA)
- Opening `second_weponselect2.la2` composes the screen the way the game does at runtime: each weapon's own
  `wpicon_*.la2` layout is loaded from the stage archives and placed in the primary / secondary / support rows, tinted
  like the game, with the screen shown as it looks once opened.
- The **Weapons** tab takes the stage script's lists (`[d7cbe5] -group N -wp_id <id> <cost> …`), scrolls each row,
  picks the character (unique weapons only appear for their owner, as in the game) and toggles Drebin Points mode
  (empty first slot, cost labels, over-budget weapons faded). Exports include the weapons.

### Editing
- Click an object in the preview (or the object tree) to select it; drag it to move, or nudge with
  Shift + arrow keys.
- Edit every field of an object's state: position, size, colour index, texture, UV, blend, rotation, scale, text,
  text layout, visibility.
- **Structural edits** with automatic rebuilding of every size, offset and header count:
  add new objects of any type, duplicate or delete subtrees, add / remove / resize raw packets, edit action keys,
  toggle an action's loop flag, edit the colour, UV and texture tables.
- Undo / redo (Ctrl+Z / Ctrl+Y) for every edit.
- Stock files rebuild **byte for byte**, so an unedited save is identical to the original.

### Textures
- Textures are found automatically in the folder's `.qar` / `.txn` / `.dlz` archives (DXT1 / DXT3 / DXT5, atlases,
  MGS4 textures embedded in TXN files), including MGO2's base / patch stage pairs.
- View each texture with the UV rectangles that use it, and download it as PNG.
- **Replace a texture** with any image: it is resized to the texture, pasted into its atlas, re-encoded as DXT with
  the original mip layout, and written into the archive's data entries.

### Export and saving
- **Video** (small files, made by the browser's own encoders):
  - **AV1 4:4:4** — full colour resolution (no chroma subsampling, the RGB pixels are stored directly) in three
    presets: *high quality*, *near-lossless* and *compact*, all visually lossless (about 51–55 dB PSNR).
  - **VP9 WebM** and **H.264 MP4** for the widest compatibility (4:2:0 colour).
  - Long videos stream straight to the chosen file in Chrome / Edge, so length is not limited by memory.
- **Exact animated images:** lossless **WebP** (the default; or lossy 95 → 50) and **APNG**. Frames after the first
  store only the area that changed, with unchanged pixels left transparent, so the result is pixel-exact; timing is
  exact.
- **Transparent background** (the default): PNG, WebP and APNG keep the layout's real alpha, so exports can be
  composited over anything. Untick *Transparent* or pick a colour for a solid background; video has no alpha and
  always uses the picked colour.
- **Freeze last frame** plays the action once and stops on its final frame, in the preview and in exports (animated
  images then play once instead of looping). Exports always include the final frame, at every speed; at 1× they sample
  exactly the game's 60 fps frames.
- Single frames as PNG (without the selection outline).

Which to choose: animated layouts that change across the whole screen every frame (fades, scrolling, video-like
backgrounds) make any lossless image format huge — a 10-minute MGS4 clip is around 13 GB as lossless WebP but
about 320 MB as AV1 4:4:4 near-lossless, or under 100 MB as H.264. Use the image formats for short or mostly static
animations, or when you need every pixel exact.
- Save the edited `.la2`, the `.dar` archive that holds it (with the edited file inside, re-encrypted for MGO2),
  or the edited texture archives.

## Supported games and files

| Game | Platform | LA2 location | Notes |
|---|---|---|---|
| Metal Gear Solid 4 | PS3 | `slotdat/*/N/*.la2`, stage archives | big-endian; very large layouts supported; PSN releases are encrypted |
| Metal Gear Online 2 | PS3 | inside `stage/*/*.dar` | stage archives are encrypted; decrypted automatically |
| Metal Gear Arcade | PC | `stage/*/Dar/*.la2`, `*.dar` | little-endian archives |

Open the folder that holds the files — a single stage, a `slotdat` folder, `USRDIR/o`, or a whole game tree.
LA2 Studio lists the folders that contain layouts; pick one to see its files.

## Getting started

### Use it online
Open **https://zoft123.github.io/LA2_Studio/** in a current Chrome, Edge, Firefox or Safari, then:

1. **Open folder…** (or **Upload folder** in browsers without folder access) and choose your game files.
2. Pick a folder in the tree, then a file in the list.
3. Choose an action and press **▶** (Space) to play it.

### Run it locally
The app is a static site with no build step. Serve the repository folder with any static web server, for example:

```sh
git clone https://github.com/Zoft123/LA2_Studio.git
cd LA2_Studio
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly from disk does not work: browsers do not load JavaScript modules from `file://`.)

## Using LA2 Studio

| Area | What it does |
|---|---|
| **Folders / Files** | Folders that contain LA2 data, then the layouts in the selected folder (loose files and `.dar` entries). Tick *subfolders* to include everything below. |
| **Toolbar** | Action, also play (extra looping actions), play, frame, play mode, freeze last frame, speed (1× = the game's 300 ticks per second), zoom (*fit* scales to the window), transparent / solid background colour, drag-to-move. |
| **Crop** | Enable a custom viewport, enter X / Y / W / H, select an area by dragging, or reset to the full layout. Applies to the live view and exports. |
| **Export / Save** | Animation export, frame PNG, undo / redo / revert, save `.la2`, `.dar` and edited textures. |
| **Objects** | The object tree. Untick to hide in the preview only; add new objects at the root. |
| **Properties** | Fields of the selected object, duplicate / delete, add child objects, raw packet editor. |
| **Textures** | Textures with their UV rectangles; PNG download, replacement, wider texture search. |
| **Tables** | Colour, UV and texture tables. |
| **Action keys** | Tracks and keys of the selected action, with commands decoded; loop flag. |
| **File** | Header sections, object counts, layers and fonts with libla's names. |

**Keyboard:** Space play / stop · ← / → step a frame · Shift + arrows nudge the selection (Ctrl for 10 px) ·
Ctrl+Z / Ctrl+Y undo / redo · `/` filter files · `o` open folder · Esc clear the selection.

**Edits stay in the browser** until you save them: use **Save .la2**, **Save .dar** or **Save textures** to
download the edited files, then copy them into your game folder (keep a backup of the originals).

To crop, click **Select area**, then drag a rectangle on the full layout. Selection pauses playback;
press Play again to watch the cropped animation. **Esc** or **Cancel crop** keeps the previous crop.
You can also tick **Crop** and enter **X**, **Y**, **W**, and **H** in layout pixels, including negative
coordinates. Numeric changes update the live view while playback continues. **Reset** restores the full
layout. Each file remembers its crop until the page is reloaded; undo/redo of layout edits keeps it.

The same crop is used for frame PNG, WebP, APNG, and video exports. Zoom still controls output resolution:
choose zoom **1** to export the entered width and height in pixels. Video exports round odd dimensions up
to an even size. Cropping changes framing only; it does not move objects or change a saved `.la2` file.

## How files are found

- **Textures** come from the selected folder's archives first, then the folders above it up to its stage folder.
  Extracted `Dar` layouts also find sibling `Qar` TXNs and their parent folder's DLZs. MGO2's
  `o/stage/<name>` and `o/dl/p/stage/<name>` folders are paired automatically. If something is still missing,
  *Search everything* in the Textures tab indexes every archive in the opened folder.
- **MGO2 DLC textures** follow the game's own resolution: a patch folder's `.dci` index remaps a patched TXN's
  image numbers into the indexed DLZs (`resident_nodld_013000.dlz`, …), and its unchanged images still come from the
  base stage folder's DLZs.
- **MGO2 decryption** uses the stage folder name (`stage/<name>`) taken from the path; for copies kept elsewhere it
  tries the folder names it can see, and **Settings** lets you set the key by hand.
- **Disc and PSN title IDs:** when the opened folder includes the title ID folder, it decides encryption. `USRDIR/o`
  (MGO2) is always encrypted. `USRDIR/mgs` (MGS4) is encrypted on the PSN releases (NPUB31633, NPEB02182,
  NPJB00698) and plain on the Blu-ray discs (BLUS30109, BLES00246, BLJM67001–3, BLJM57001, BLUS30148, BLAS55004/5,
  BLKS25002). BLJM60082 is the standalone MGO disc. Saves inside an encrypted area are always encrypted.

## Browser support

A browser with **WebGL 2** is required (all current desktop browsers).

- *Open folder…* uses the File System Access API (Chrome, Edge, Opera); other browsers use *Upload folder*, which
  reads the same files.
- Animated WebP export uses the browser's WebP encoder (Chrome, Edge, Firefox). Where it is missing (Safari), the
  export falls back to APNG.
- Video export uses WebCodecs (Chrome, Edge; recent Firefox and Safari support part of it). AV1 4:4:4 plays in
  Chrome, Edge, Firefox, VLC and mpv; H.264 MP4 plays almost everywhere. Unsupported formats fall back to another
  available one.

## Limitations

- Re-compressed `.dlz` files decompress to exactly the edited data, but are not byte-identical to the originals
  (a different deflate implementation); the games read them normally.
- Adding brand-new textures (new TXN entries) is not supported yet; existing textures can be replaced.
- Action keys can be edited per track; creating new actions and tracks is not available yet.
- Very long tracks (MGS4 has tracks with thousands of keys) show the first 400 keys in the key editor.
- Names of objects and actions are 24-bit hashes; the original names are not stored in the files.

## Roadmap

Planned and likely future updates:

- **New textures:** add new TXN texture entries and data, not only replace existing ones.
- **Action authoring:** create actions and tracks, and a visual keyframe timeline instead of the key table.
- **Visual UV editor** on the texture view (drag UV rectangles).
- **Layer management:** create, reorder and toggle layers, and assign objects to them.
- **Session persistence:** keep edits across reloads (IndexedDB) and write them straight back into the opened
  folder where the browser allows it.
- **Name dictionary:** readable names for object, action and texture hashes contributed by the community.
- **More exports:** GIF and sprite-sheet export, audio-free MOV / ProRes-style intermediates if browsers gain them.
- **Font tools:** glyph table view and editing.

Issues and pull requests are welcome.

## Development

Plain ES modules, no build step. Vendored libraries (MIT): [fflate](https://github.com/101arrowz/fflate)
(deflate / inflate), [webm-muxer](https://github.com/Vanilagy/webm-muxer) and
[mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (video containers).

```
index.html, css/          the page
js/core/bin.js            binary reading / writing, the MGS string hash
js/formats/               la2.js (reader), model.js (writer and edits), archives.js (DAR / QAR / DLZ),
                          textures.js (TXN / DLD / DXT decoding), dxtenc.js (DXT encoding), mgo2crypt.js
js/engine/                scene.js (state, playback, timeline, draw list), gl.js (WebGL renderer), export.js,
                          playback.js (play modes, export frame schedule), viewport.js (crop geometry)
js/app/                   main.js (UI), library.js (folders, decryption, texture lookup), crop.js, texedit.js
docs/FORMAT.md            format reference
tests/check.mjs           `npm test`: playback, export, crop and app regression tests
tests/run.mjs             round-trip tests against your own game files
tests/render.html         WebGL2 alpha and crop checks, run in a browser
tests/serve.py            development server for automated browser tests
```

Run the playback, export timing and alpha regression tests (Node.js 18 or later):

```sh
npm test
```

To also run the format tests on your own files:

```sh
npm test -- /path/to/game/folder [more folders...]
```

The format tests can also be run directly:

```sh
node tests/run.mjs /path/to/game/folder [more folders...]
```

They check that every layout parses, rebuilds byte for byte, survives structural edits and plays.

For actual GPU alpha checks, serve the app and open `tests/render.html` in a WebGL2 browser.
It checks transparent and solid backgrounds, opaque draws, and normal blending after an opaque draw.

The file format is described in [docs/FORMAT.md](docs/FORMAT.md).

## Credits

- MGO2 stage-file decryption follows the method implemented by **HavenStudio2** from the MGO2 revival community.
- Deflate / inflate: **[fflate](https://github.com/101arrowz/fflate)** by Arjun Barrett (MIT).
- Video containers: **[webm-muxer](https://github.com/Vanilagy/webm-muxer)** and
  **[mp4-muxer](https://github.com/Vanilagy/mp4-muxer)** by Vanilagy (MIT).

## Legal

LA2 Studio is an unofficial fan-made tool. It is not affiliated with, endorsed by or connected to Konami or
Kojima Productions. *Metal Gear*, *Metal Gear Solid*, *Metal Gear Online* and *Metal Gear Arcade* are trademarks of
their respective owners. This repository contains no game files or game assets; you need your own copies of the
games' files to use it.

## License

[MIT](LICENSE)
