# Peace Walker LA3 runtime findings

These findings come from static analysis of the user's decrypted Japanese PSP `EBOOT.elf` (`NPJH50045`),
SHA-256 `10620fb9a6cba840cda0b9900ed23425c16ada7f286a8881847a822c61131ff5`, on 2026-11-27.
Addresses below are module-relative addresses in that executable. They are not addresses for other releases.
The file was inspected with IDA's MIPS decompiler and instruction listing; the PSP game was not executed.
The HD files were independently checked against the PS3 format swappers and the local layout corpus.

## Loader and animation keys

`0xDE018` builds an LA3 instance. Its section table at `0x38ED90` maps chunk IDs to callbacks
`0xDDA24` through `0xDDAF0`, which store the section pointers. `0xE04B4` indexes object records.
This is the layout implementation, unlike the unrelated PS3 GPU display-list interpreter encountered earlier.

`0xE1DC8` is the per-track key player:

| Type | Observed operation |
| --- | --- |
| 0 | End the track. |
| 1 | Apply mask values at rate 10000 through `0xE05E0`. |
| 2 | Apply mask values over a duration, with clamped rates from 0 to 10000. Zero duration is treated as one tick. |
| 3 | Wait for the stored duration. |
| 4 | Pass `(command, argument)` pairs through `0xDFC10`. That function calls the callback at instance `+80`, passing application context. It does not interpret LA2 command hashes. |
| 5 | Look up the object hash at key `+8` using `0xCB0D0`, then pass the action hash at `+4` and that object to `0xE1A38`. A missing object does nothing. |

`0xE1A38` selects exact action-record hashes when the high byte is nonzero, otherwise selects matching low
24-bit hashes. Its explicit object argument overrides each source track's object. `0xE0FF8` checks whether
matching tracks are already running on that object. The key-5 call clears the loop flag. Studio implements
these scoped starts without adding generated actions to the file browser.

Key-4 numbers belong to the application's callback contract. A value such as 7 cannot be called “show caption”
for every LA3 file merely because it appears in one caption layout. Studio keeps the number and argument in
the event timeline and does not simulate application callbacks.

## Properties and morphs

`0xE05E0` walks set mask bits in order and consumes one signed 16-bit value per bit. The property handlers
confirmed in its dispatch tables are:

| Bits | Handler | Observed behavior |
| --- | --- | --- |
| 2, 18–23, 26 | `0xE2BB8` | Discrete scalar: changes only when the morph rate reaches 10000. |
| 4, 6, 7, 10 | `0xE27C8` | Normal point-list morph: position, size, UV and String spacing. Components round by the direction of change. |
| 5, 8, 12, 13 | `0xE33FC` | Packed colour-list morph, with rounding based on the direction of each channel's change. Not all these bits are converted into Studio properties yet. |
| 9 | `0xE2F40` | Copy a byte list from sections B0/B1 into the object's control-vertex bindings. |
| 11 | `0xE1154` | Set text through the C0/C1 text table. |
| 16 | `0xE30A8` | Signed angle; choose the shortest path across the 16-bit wrap boundary. |
| 17, 24, 25, 27 | `0xE3250` | Signed scalar morph with slope-based rounding. |

The transform builder `0xCF050` negates the local angle and uses signed scale divided by 256.
Studio preserves the angle's original 16-bit precision before converting to its internal 4096-units-per-turn
representation. Other LA2 and PS2 layouts keep their existing interpolation rules.

PS3 cross-checks also confirm the key player at `0x1F5DFC`, shortest-arc angle handler at `0x1F842C`, blend
selection at `0x1FD4B8` / `0x208314` through `0x17438`, and negated drawing rotation in `0x1FBC20`
(`lhz` at `0x1FBD2C`, `neg` at `0x1FBD5C`). These refer to the PS3 binary identified in the DDS section below.

The runtime has two dispatch tables. Normal playback uses `0x41C720`, whose point handler is `0xE27C8`.
Instance flag `0x800` selects `0x41C6A0` and a snapshot-based point handler, `0xE2CB4`, which truncates instead.
The PS3 player `0x1F5DFC` has the same choice (`0x1F7198` normal, `0x1F7648` snapshot).
These handlers represent instance modes rather than a PSP/PS3 format difference. Studio models the normal mode;
the game's instance flags are not stored in an LA3 file.

`0xCD6B8` uses the byte binding list to select vertices from a Ctrl ancestor's position list.
`0xCF79C` reads properties `0x100000` and `0x10000000` (bits 20 and 28), then calls `0xCD3D0`, which configures
stencil write/test state. The earlier “RSprt flags” names were incomplete: these properties participate in
stencil masking. Studio parses and names them but does not yet render those masks or control-vertex bindings.

## Blend modes

Sprite and primitive draw routines such as `0xD161C` and `0xD1A7C` fetch property `0x40000` (bit 18).
They select a preset through `0x79BCC`; `0x79B70` applies it and `0x3390E8` packs the hardware blend register.

| Value | Operation | Source factor | Destination factor |
| --- | --- | --- | --- |
| 0 / no property | Add | Source alpha | One minus source alpha |
| 1 | Add | Source alpha | Fixed white (1) |
| 2 | Reverse subtract | Source alpha | Fixed white (1) |
| Other | Blending disabled | — | — |

The register values agree with [PSPSDK's blend operations and factors](https://github.com/pspdev/pspsdk/blob/master/src/gu/pspgu.h).
This replaces the previous inference from glow sprites. Alpha tests and stencil behavior remain separate from
the blend equation and are not fully emulated by the viewer.

## Versions and relocations

The tested HD dump contains 23 loose version-4 layouts, 388 version-5 layouts and 5527 version-7 layouts.
The earlier report that all 388 version-5 files fail a chunk walk was incorrect: only three have four trailing
bytes after the end chunk. Version-4 files can have trailers too; the game stops at the end chunk.

Versions 4/5 use 16-bit point counts and first-point indices. Version 7 uses an 8-bit point count and a
24-bit first-point index. The PS3 swap routines and PSP `0xE2CB4` agree on the high-index byte. Texture-hash
indices become 16-bit only for version 6 or later with at least 256 hashes; Studio enables the verified versions
4, 5 and 7 and continues to reject versions absent from the supplied corpus.

IDA misrelocated some paired MIPS HI/LO references in the saved database. Do not subtract a single guessed base
from every displayed address. For example, raw instructions at `0xE1EB4/0xE1EB8` encode segment-relative
`0x70660`; adding data segment virtual address `0x3AC140` gives reset-handler table `0x41C7A0`, whereas the
database displays `0x7C88E0`. The two 32-entry property-handler tables are at `0x41C6A0` and `0x41C720`.
The table data and original instructions were checked independently before following their function pointers.

## DDS padding and atlas coordinates

This trace uses the supplied PS3 `NPUB30611` EBOOT, SHA-256
`60eec4ad3ac2b809e113e0dd480b53f3f3f3bb1703aa90ffe6e2ebfe064ac744`; addresses in this section belong to that binary.

The PS3 texture binder `0x2D6F8` passes the TXP image's encoded buffer dimensions to `0xC51020`.
The display-list interpreter `0xC2018C` retains those dimensions. Shader setup at `0xC20F60` scales the texture
coordinates and offsets by encoded-buffer size divided by the actual GPU texture size before `0xC254D0`.
Consequently the atlas rectangle in decoded pixel coordinates is the TXP's fractional rectangle multiplied by
its encoded buffer dimensions, even when the DDS has a larger allocation.

The previous implementation multiplied by DDS dimensions. For example, a 48-row font in a 64-row source buffer
can live in a 128-row DDS allocation. Multiplying its 0.75 height by 128 sampled 96 rows and selected the wrong
glyphs; multiplying by 64 samples the correct 48. The fix uses format metadata, with no image-content heuristic.

## Verification limits

Synthetic regression tests cover the version-dependent tables, blend modes, raw angles, signed scale,
point/UV/spacing morphs, callback separation, object-scoped key-5 starts and padded DDS atlases. The offline corpus check exercises
Studio's parser, texture decoder, actions and primitive generation; a successful check does not establish
pixel-for-pixel agreement with the running game. There was no in-game replay in this investigation.

The fresh browser check could not start because this session denied creating the local development server's
socket. Remaining rendering gaps include control-vertex bindings, stencil clipping, application-written text,
unconverted Typing properties, the snapshot interpolation mode and application callbacks. Texture references absent from the tested extraction
also remain unresolved; absence from that extraction does not prove that a pack is generated at runtime.

Local checks on 2026-11-27: `npm test` passes; the stage/slot corpus exercises 11137 layout occurrences (including
loose copies and their archive entries), with no parse/play failures. The 5938 loose files include all 411 older
layouts. The per-folder texture check resolves 45118 of 47424 references; missing pack hashes are `591a1b`,
`ad7f24`, `2c9caa` and `830b44`. These counts describe this extraction, not every release. PS2 regression
renders cover 404 layouts and 3026 texture references; all 404 PNGs are byte-identical to the preceding version.
