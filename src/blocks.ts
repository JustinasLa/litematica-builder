// Block name -> approximate RGB. No Mojang assets; these are hand-picked
// averages. Unknown blocks fall back to a stable hash-derived colour.

import { shapeFor } from './shapes'

const COLOURS: Record<string, number> = {
  // stone family
  stone: 0x7d7d7d,
  smooth_stone: 0x9e9e9e,
  cobblestone: 0x7a7a7a,
  mossy_cobblestone: 0x6b7a5c,
  stone_bricks: 0x7a7a7a,
  mossy_stone_bricks: 0x6f7a63,
  cracked_stone_bricks: 0x6e6e6e,
  chiseled_stone_bricks: 0x787878,
  andesite: 0x888889,
  diorite: 0xbfbfbd,
  granite: 0x9a6a55,
  calcite: 0xdfdedb,
  tuff: 0x6c6e65,
  bedrock: 0x565656,
  deepslate: 0x515156,
  cobbled_deepslate: 0x4f4f55,
  deepslate_bricks: 0x4a4a4f,
  deepslate_tiles: 0x393a3e,
  polished_deepslate: 0x4b4b50,
  blackstone: 0x2b2529,
  basalt: 0x4c4a4f,
  netherrack: 0x6f3634,
  end_stone: 0xdcdfa4,
  obsidian: 0x140d21,
  // soil / ground
  dirt: 0x8b5f3c,
  coarse_dirt: 0x7f5836,
  rooted_dirt: 0x906d52,
  podzol: 0x5c3f19,
  mycelium: 0x6f6169,
  farmland: 0x5b3a1c,
  dirt_path: 0x977f47,
  grass_block: 0x6a9c41,
  sand: 0xdbd3a0,
  red_sand: 0xbe6721,
  sandstone: 0xdad2a5,
  red_sandstone: 0xbe6721,
  gravel: 0x857f7e,
  clay: 0xa0a7b4,
  soul_sand: 0x513e33,
  soul_soil: 0x4b3a2f,
  snow: 0xf2fafa,
  snow_block: 0xf2fafa,
  powder_snow: 0xf7feff,
  ice: 0x91b7f2,
  packed_ice: 0x8cb5f0,
  blue_ice: 0x74a8f7,
  // woods
  oak_log: 0x9c7f4e,
  oak_planks: 0xa4834d,
  spruce_log: 0x50351c,
  spruce_planks: 0x6f5334,
  birch_log: 0xd7cb8d,
  birch_planks: 0xc6b177,
  jungle_log: 0x9a7248,
  jungle_planks: 0xa07550,
  acacia_log: 0x9a5e33,
  acacia_planks: 0xa85b25,
  dark_oak_log: 0x3f2d18,
  dark_oak_planks: 0x4b3319,
  mangrove_log: 0x77372a,
  mangrove_planks: 0x763c3e,
  cherry_log: 0x785461,
  cherry_planks: 0xe3b7ab,
  bamboo_planks: 0xc3a252,
  crimson_planks: 0x6a344b,
  warped_planks: 0x2b6a68,
  stripped_oak_log: 0xb08b4f,
  // leaves / plants
  oak_leaves: 0x4a8a2c,
  spruce_leaves: 0x35613a,
  birch_leaves: 0x6f9a48,
  jungle_leaves: 0x3f8b1f,
  acacia_leaves: 0x5c8b2a,
  dark_oak_leaves: 0x3e7420,
  azalea_leaves: 0x5d8f36,
  mangrove_leaves: 0x3e7d2a,
  cherry_leaves: 0xe3a8c4,
  grass: 0x6a9c41,
  short_grass: 0x6a9c41,
  tall_grass: 0x6a9c41,
  fern: 0x5f8f3c,
  vine: 0x3d7a22,
  moss_block: 0x596d20,
  hay_block: 0xa78c1a,
  // fluids
  water: 0x3f5fbd,
  lava: 0xd45b12,
  // ores
  coal_ore: 0x5b5b5b,
  iron_ore: 0xac8e77,
  copper_ore: 0xa2725a,
  gold_ore: 0xa79141,
  redstone_ore: 0x8f6464,
  lapis_ore: 0x5b7695,
  diamond_ore: 0x6fa9a4,
  emerald_ore: 0x5aa06e,
  quartz_ore: 0x7c534e,
  ancient_debris: 0x5c4038,
  deepslate_coal_ore: 0x474749,
  deepslate_iron_ore: 0x77706a,
  deepslate_gold_ore: 0x79704a,
  deepslate_diamond_ore: 0x4f7a78,
  // metal / mineral blocks
  iron_block: 0xd8d8d8,
  gold_block: 0xf8d642,
  diamond_block: 0x63e0d8,
  emerald_block: 0x41d772,
  lapis_block: 0x1d47a5,
  redstone_block: 0xa91009,
  netherite_block: 0x43393c,
  copper_block: 0xc06a4c,
  coal_block: 0x111111,
  amethyst_block: 0x9166c4,
  // bricks and misc building
  bricks: 0x976153,
  nether_bricks: 0x2d161a,
  red_nether_bricks: 0x460709,
  prismarine: 0x639a8f,
  prismarine_bricks: 0x62b0a2,
  dark_prismarine: 0x33574a,
  purpur_block: 0xa87ca8,
  glowstone: 0xf8c55c,
  sea_lantern: 0xaebfba,
  bookshelf: 0x9a7f4d,
  crafting_table: 0x7d5334,
  furnace: 0x767676,
  glass: 0xcfe7ef,
  tinted_glass: 0x37333a,
  sponge: 0xc3c144,
  pumpkin: 0xc17615,
  melon: 0x6e972a,
  tnt: 0xa32d24,
  cactus: 0x53772e,
  sculk: 0x0d1418,
  honeycomb_block: 0xe5952a,
  mud: 0x3c3a3e,
  mud_bricks: 0x8a6a4e,
  terracotta: 0x985e43,
  // colour families: <colour>_wool / _concrete / _terracotta / _stained_glass
}

const DYE: Record<string, number> = {
  white: 0xe9ecec,
  orange: 0xf07613,
  magenta: 0xbd44b3,
  light_blue: 0x3aafd9,
  yellow: 0xf8c627,
  lime: 0x70b919,
  pink: 0xed8dac,
  gray: 0x3e4447,
  light_gray: 0x8e8e86,
  cyan: 0x158991,
  purple: 0x792ab3,
  blue: 0x35399d,
  brown: 0x724728,
  green: 0x546d1b,
  red: 0xa12722,
  black: 0x141519,
}

const DYE_FAMILY = new Set([
  'wool',
  'carpet',
  'concrete',
  'concrete_powder',
  'stained_glass',
  'stained_glass_pane',
  'terracotta',
  'glazed_terracotta',
  'shulker_box',
  'bed',
  'banner',
  'candle',
])

const AIR = new Set(['air', 'cave_air', 'void_air'])

const NON_OPAQUE_EXACT = new Set([
  'water',
  'lava',
  'glass',
  'tinted_glass',
  'ice',
  'frosted_ice',
  'slime_block',
  'honey_block',
  'barrier',
  'powder_snow',
  'scaffolding',
  'cobweb',
])

// Shaped blocks (slabs, stairs, fences, ...) are not listed here: shapes.ts is
// the single authority on those, so the two lists cannot drift apart.
const NON_OPAQUE_SUFFIX = [
  '_leaves',
  '_glass',
  '_glass_pane',
  '_door',
  '_bars',
  '_pane',
  '_sign',
  '_bed',
  '_candle',
  '_chain',
  '_torch',
  '_rail',
  '_button',
  '_pressure_plate',
]

/** Strip the namespace; block properties never affect our lookups. */
export function baseName(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

export function isAir(name: string): boolean {
  return AIR.has(baseName(name))
}

/**
 * Does this block hide the faces of its neighbours? Anything with a shape in
 * shapes.ts does not: it no longer fills its cube.
 */
export function isOpaque(name: string, properties: Record<string, string> = {}): boolean {
  const base = baseName(name)
  if (AIR.has(base) || NON_OPAQUE_EXACT.has(base)) return false
  if (shapeFor(base, properties) !== null) return false
  return !NON_OPAQUE_SUFFIX.some((suffix) => base.endsWith(suffix))
}

/** Stable FNV-1a hash so unknown blocks get a distinguishable, fixed colour. */
function hashColour(base: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < base.length; i++) {
    h = Math.imul(h ^ base.charCodeAt(i), 0x01000193) >>> 0
  }
  // Keep it mid-tone so it reads against the dark background.
  const r = 80 + ((h >>> 16) & 0x7f)
  const g = 80 + ((h >>> 8) & 0x7f)
  const b = 80 + (h & 0x7f)
  return (r << 16) | (g << 8) | b
}

export function blockColour(name: string): number {
  const base = baseName(name)
  const exact = COLOURS[base]
  if (exact !== undefined) return exact

  const underscore = base.indexOf('_')
  if (underscore !== -1) {
    const dye = DYE[base.slice(0, underscore)]
    if (dye !== undefined && DYE_FAMILY.has(base.slice(underscore + 1))) return dye
    // light_blue / light_gray have two underscores.
    const second = base.indexOf('_', underscore + 1)
    if (second !== -1) {
      const dye2 = DYE[base.slice(0, second)]
      if (dye2 !== undefined && DYE_FAMILY.has(base.slice(second + 1))) return dye2
    }
  }
  // Shared-material variants: stairs/slabs/walls of a known block.
  for (const suffix of ['_stairs', '_slab', '_wall', '_fence', '_button', '_pressure_plate']) {
    if (base.endsWith(suffix)) {
      const stem = base.slice(0, -suffix.length)
      const known = COLOURS[stem] ?? COLOURS[`${stem}s`] ?? COLOURS[`${stem}_planks`]
      if (known !== undefined) return known
    }
  }
  return hashColour(base)
}
