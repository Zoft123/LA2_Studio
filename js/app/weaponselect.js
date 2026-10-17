// The Metal Gear Online 2 Weapon Select screen (second_weponselect2.la2) as the game builds it at runtime.
//
// The layout only holds the frame: three rows (primary / secondary / support) of six cells, each a frame sprite
// plus a String for the Drebin Point cost. The weapons themselves are separate layouts, one per weapon
// (wpicon_<name>.la2 in the stage's resident archives), which the game loads and places in the cells:
//   * the icon's group object (0xA9B0D5, under its ROOT) is moved to the cell frame's x and the row's y
//     (2864 / 5168 / 7488, 1/16 px); the shield (73) and Base Buster (68) sit 160 left / 128 up;
//   * primary-row icons are moved again by (+230, +67) and scaled to 217/256;
//   * the group is tinted 0x3CC0E9FF (0xFF593AFF for a weapon that cannot be used), alpha 0x20 when it costs more
//     than the player's Drebin Points;
//   * in Drebin Points mode each row starts with an empty "no weapon" entry and the cost Strings show
//     cost x multiplier; otherwise they are hidden;
//   * unique characters' weapons are removed from everyone else's lists (a table in the game's executable);
//   * the screen's container starts at alpha 0 and is faded in by action 0x9B20A3 when the screen opens.
// The lists come from the stage script ([d7cbe5] -group 0|1|2 -wp_id <id> <cost> ...).
import { LA2 } from '../formats/la2.js';
import { Scene } from '../engine/scene.js';

/** Weapon id -> icon layout (the game's weapon icon table). */
export const ICON_NAMES = {
  1: 'wpicon_stunknife', 2: 'wpicon_ruger', 3: 'wpicon_operator', 4: 'wpicon_socom', 5: 'wpicon_de', 6: 'wpicon_fn57',
  7: 'wpicon_siggsr', 8: 'wpicon_de', 9: 'wpicon_b_deserteaglelb', 10: 'wpicon_thor', 11: 'wpicon_gove',
  12: 'wpicon_sleepspray', 13: 'wpicon_gundelsol', 14: 'wpicon_pss', 15: 'wpicon_glock18', 16: 'wpicon_Rknife',
  17: 'wpicon_mp7', 18: 'wpicon_mp5sd5', 19: 'wpicon_ingram', 20: 'wpicon_p90', 21: 'wpicon_bizon', 22: 'wpicon_patriot',
  23: 'wpicon_skopion', 24: 'wpicon_m4', 25: 'wpicon_ak102', 26: 'wpicon_g3a3', 27: 'wpicon_b_xm8compact', 28: 'wpicon_fal',
  29: 'wpicon_Vblade', 30: 'wpicon_scar', 31: 'wpicon_xm8', 32: 'wpicon_mk46', 33: 'wpicon_hk21e', 34: 'wpicon_pk',
  35: 'wpicon_m60e4', 36: 'wpicon_Vknife', 37: 'wpicon_m870', 38: 'wpicon_saiga', 39: 'wpicon_vss', 40: 'wpicon_m82a2',
  41: 'wpicon_dsr1', 42: 'wpicon_m14e', 43: 'wpicon_mosin', 44: 'wpicon_svd', 45: 'wpicon_railgun', 46: 'wpicon_bomb',
  47: 'wpicon_missouri', 48: 'wpicon_katana', 49: 'wpicon_javelin', 50: 'wpicon_rpg7', 51: 'wpicon_m72a3', 52: 'wpicon_grd',
  53: 'wpicon_grd_wp', 54: 'wpicon_grd_flash', 55: 'wpicon_grd_chaff', 56: 'wpicon_grd_smoke', 57: 'wpicon_grd_smoke',
  58: 'wpicon_grd_smoke', 59: 'wpicon_grd_smoke', 60: 'wpicon_grd_smoke', 61: 'wpicon_firebottle', 62: 'wpicon_magazine',
  63: 'wpicon_b_emp', 64: 'wpicon_claymore', 65: 'wpicon_sleepingmine', 66: 'wpicon_c4', 67: 'wpicon_slpc4',
  68: 'wpicon_b_basebuster', 69: 'wpicon_bookA', 70: 'wpicon_mk2book', 71: 'wpicon_gop', 72: 'wpicon_s-sonar',
  73: 'wpicon_b_shield', 74: 'spicon_masterkey', 75: 'wpicon_xm320', 76: 'wpicon_gp30', 77: 'spicon_sup_oprt',
  78: 'spicon_sup_mk23', 79: 'spicon_sup_gove', 80: 'spicon_sup_m10i', 81: 'spicon_sup_p90', 82: 'spicon_sup_m4a1',
  83: 'spicon_sup_m14e', 84: 'spicon_scope', 85: 'spicon_dotsight', 86: 'spicon_mp7dotsight', 87: 'spicon_riflelight',
  88: 'spicon_lasersight', 89: 'spicon_handgunlight', 90: 'spicon_gripA', 91: 'spicon_gripB',
};

/** Per row: the six cell frames (Sprt) and cost labels (String), by object hash. */
export const ROWS = [
  { name: 'Primary', frames: range(0x8ec04a), costs: range(0x86a04a) },
  { name: 'Secondary', frames: range(0x8ed4fe), costs: range(0x81aba0) },
  { name: 'Support', frames: range(0x8ed918), costs: range(0x86b918) },
];
function range(h) { return [0, 1, 2, 3, 4, 5].map(i => h + i); }
export const ROW_Y = [2864, 5168, 7488];
const ICON_GROUP = 0xA9B0D5;
const SCREEN = 0xA493BF;          // the screen's container: invisible in the file, shown by action 0x9B20A3 on open

/** Unique weapons and the character type that keeps them (everyone else's lists drop them). */
export const UNIQUE_OWNER = new Map([[9, 2], [27, 3], [40, 3], [72, 5], [47, 5], [10, 4], [71, 4], [48, 6], [16, 6], [29, 9], [36, 9]]);
export const CHARACTERS = [[0, 'Soldier (custom character)'], [2, 'Meryl'], [3, 'Johnny'], [5, 'Mei Ling'],
  [4, 'Liquid Ocelot (type 4)'], [6, 'Raiden (type 6)'], [9, 'Vamp (type 9)']];

/** The stage scripts' general lists ([d7cbe5] without -team): weapon id / cost pairs per row. */
export const DEFAULT_LISTS = [
  '9 4 27 4 71 0 40 40 23 0 20 8 18 8 22 14 25 4 24 8 30 8 31 14 26 14 44 2 43 0 42 10 39 10 41 28 37 3 38 18 35 20 73 0 50 80',
  '10 4 7 0 2 0 3 0 15 5 4 10 8 12 5 12',
  '52 0 53 2 54 0 55 2 56 0 57 2 58 2 59 2 63 6 64 3 65 6 66 4 67 5 69 0',
];

/** Is this the Weapon Select layout (it has the cell objects)? */
export function isWeaponSelect(la) {
  const hashes = new Set(la.objects.map(o => o.hash));
  return ROWS.every(r => r.frames.every(h => hashes.has(h)) && r.costs.every(h => hashes.has(h)));
}

/** "-wp_id 9 4 27 4 …", a whole [d7cbe5] command or just numbers -> [[id, cost], …]. */
export function parseList(text) {
  const t = String(text || '');
  const at = t.search(/-wp_id\b/);
  const nums = (at >= 0 ? t.slice(at + 6) : t).split(/[\s,]+/).filter(Boolean)
    .map(s => /^-?\d+$/.test(s) ? +s : NaN);
  const stop = nums.findIndex(n => Number.isNaN(n));
  const vals = stop >= 0 ? nums.slice(0, stop) : nums;
  const out = [];
  for (let i = 0; i + 1 < vals.length; i += 2) out.push([vals[i], vals[i + 1]]);
  return out;
}

export function defaultConfig() {
  return { enabled: true, lists: DEFAULT_LISTS.slice(), scroll: [0, 0, 0], character: 0, drebin: false, budget: 0, mult: 250 };
}

/** Builds and keeps the composition for one open Weapon Select layout. */
export class WeaponSelect {
  /** lib: the Library; dir: the layout's folder; la: the layout. */
  constructor(lib, dir, la) {
    this.lib = lib; this.dir = dir; this.la = la;
    this.byHash = new Map(la.objects.map(o => [o.hash, o.id]));
    this.icons = new Map();            // icon name -> LA2 | null (not found)
    this.missing = new Set();
  }

  /** The rows as the screen shows them: [[id, cost], …] after the unique-weapon filter and Drebin mode. */
  rows(cfg) {
    return cfg.lists.map(text => {
      let list = parseList(text).filter(([id]) => !UNIQUE_OWNER.has(id) || UNIQUE_OWNER.get(id) === cfg.character);
      if (cfg.drebin) list = [[0, 0], ...list];
      return list;
    });
  }

  /** Load the icon layouts (and their textures) that the current configuration shows. */
  async load(cfg, overrides) {
    const want = new Set();
    this.rows(cfg).forEach((list, r) => {
      for (let c = 0; c < 6; c++) {
        const e = list[(cfg.scroll[r] || 0) + c];
        if (e && ICON_NAMES[e[0]]) want.add(ICON_NAMES[e[0]]);
      }
    });
    const texHashes = [];
    for (const name of want) {
      if (this.icons.has(name)) continue;
      let la = null;
      try {
        const f = await this.lib.findLa2(name + '.la2', this.dir);
        if (f) la = new LA2(await this.lib.la2Bytes(f));
      } catch (e) { la = null; }
      this.icons.set(name, la);
      if (la) texHashes.push(...la.tex_tbl.map(([h]) => h));
    }
    if (texHashes.length) await this.lib.prepare(texHashes, overrides);
    this.missing = new Set([...want].filter(n => !this.icons.get(n)));
  }

  /** Install the composition on a Scene of the layout (patch + attached icon scenes); cfg.enabled false clears it. */
  apply(scene, cfg) {
    scene.patch = null; scene.attached = [];
    if (!cfg.enabled) return;
    const rows = this.rows(cfg);
    const cells = [];                        // [{row, col, id, cost}]
    rows.forEach((list, r) => {
      for (let c = 0; c < 6; c++) {
        const e = list[(cfg.scroll[r] || 0) + c] || null;
        cells.push({ row: r, col: c, id: e ? e[0] : 0, cost: e ? e[1] : 0, empty: !e });
      }
    });
    const mult = cfg.mult || 0, budget = (cfg.budget || 0);
    const screen = this.byHash.get(SCREEN);
    scene.patch = set => {
      // "Initial state" shows the screen as it looks once opened (the game plays its fade-in action first)
      // (MGO2's copy starts at alpha 0, MGA's starts hidden; the open action shows it at full alpha)
      if (!scene.timeline && screen !== undefined) set(screen, st => {
        const c = st.rgba.get(0) || [0xFF, 0xFF, 0xFF, 0];
        st.visible = true;
        st.rgba = new Map([[0, [c[0], c[1], c[2], 0x80]]]);
      });
      for (const cell of cells) {
        const frame = this.byHash.get(ROWS[cell.row].frames[cell.col]), label = this.byHash.get(ROWS[cell.row].costs[cell.col]);
        if (frame !== undefined) set(frame, st => { st.visible = true; });
        if (label !== undefined) set(label, st => {
          st.visible = !!cfg.drebin && !cell.empty;
          st.text = String(cell.cost * mult);
        });
      }
    };
    for (const cell of cells) {
      if (!cell.id) continue;
      const icon = this.icons.get(ICON_NAMES[cell.id]);
      if (!icon) continue;
      const frameId = this.byHash.get(ROWS[cell.row].frames[cell.col]);
      const tooExpensive = cfg.drebin && cell.cost * mult > budget;
      const rgba = [0x3C, 0xC0, 0xE9, tooExpensive ? 0x20 : 0xFF];
      const iconScene = new Scene(icon, this.lib);
      const group = icon.objects.find(o => o.hash === ICON_GROUP);
      // like the game, read the frame's position every frame (the screen's own actions may move it)
      iconScene.patch = group ? set => set(group.id, st => {
        const fst = frameId !== undefined ? (scene.state.get(frameId) || scene.initial.get(frameId)) : null;
        let x = fst && fst.xy[0] && fst.xy[0][0] ? fst.xy[0][0][0] : 0;
        let y = ROW_Y[cell.row];
        if (cell.id === 73 || cell.id === 68) { x -= 160; y -= 128; }
        if (cell.row === 0) { x += 230; y += 67; st.scale = 217; }
        st.xy = [[[x, y]]];
        st.rgba = new Map([[0, rgba]]);
      }) : null;
      scene.attached.push(iconScene);
    }
  }
}
