// Code-defined block shapes, in Minecraft's own block-model vocabulary: a list
// of boxes with from/to in 1/16-block units (plus vanilla's diagonal "cross"
// for plants), rotated by facing/half at emission time.
//
// Deliberately *not* parsed from models/*.json or blockstates/*.json: the
// bundled pack ships none, and Mojang's are not ours to copy. Anything without
// a definition here stays a full cube -- never a missing block.

import type { Face } from './textures'

export type V3 = readonly [number, number, number]

export interface Box {
  from: V3
  to: V3
  /** Vanilla texture name for all six faces; default = the block's own face texture. */
  tex?: string
}

export interface Shape {
  boxes: Box[]
  /** Vanilla's pair of diagonal, double-sided quads; one pair per texture name. */
  cross?: string[]
}

type Props = Record<string, string>

const box = (from: V3, to: V3): Box => ({ from, to })

// --- rotation ---------------------------------------------------------------
// Every oriented shape below is authored for facing=east and half=bottom, then
// turned/flipped here. One turn is 90 degrees about +Y: north -> east.

const turned = (p: V3): V3 => [16 - p[2], p[1], p[0]]

function turnBox(b: Box, turns: number): Box {
  let { from, to } = b
  for (let i = 0; i < turns; i++) {
    const a = turned(from)
    const c = turned(to)
    from = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])]
    to = [Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])]
  }
  return { ...b, from, to }
}

/** Mirror about the block's horizontal midplane, for half=top. */
const flipBox = (b: Box): Box => ({
  ...b,
  from: [b.from[0], 16 - b.to[1], b.from[2]],
  to: [b.to[0], 16 - b.from[1], b.to[2]],
})

/** Quarter turns away from the authoring convention (facing=east). */
const TURNS: Record<string, number> = { east: 0, south: 1, west: 2, north: 3 }
const turnsOf = (props: Props): number => TURNS[props['facing'] ?? 'north'] ?? 0

/** Quarter turns for a per-side connection authored on the north side. */
const SIDE_TURNS: Record<string, number> = { north: 0, east: 1, south: 2, west: 3 }

const oriented = (boxes: Box[], props: Props, top = props['half'] === 'top'): Shape => ({
  boxes: boxes.map((b) => {
    const t = turnBox(b, turnsOf(props))
    return top ? flipBox(t) : t
  }),
})

// --- stairs -----------------------------------------------------------------
// Authored for facing=east, so the tall half is at +x. Which quarter a corner
// keeps follows from the neighbour that produced the shape: for facing=east,
// outer_right means the stairs in front faces south, so the quarter kept is the
// south-east one; outer_left keeps the north-east one; inner_* keep the whole
// east half plus the far quarter on the same side.
const STEP: Record<string, [V3, V3][]> = {
  straight: [[[8, 8, 0], [16, 16, 16]]],
  outer_right: [[[8, 8, 8], [16, 16, 16]]],
  outer_left: [[[8, 8, 0], [16, 16, 8]]],
  inner_right: [
    [[8, 8, 0], [16, 16, 16]],
    [[0, 8, 8], [8, 16, 16]],
  ],
  inner_left: [
    [[8, 8, 0], [16, 16, 16]],
    [[0, 8, 0], [8, 16, 8]],
  ],
}

// --- fences and walls -------------------------------------------------------
const FENCE_POST = box([6, 0, 6], [10, 16, 10])
const FENCE_ARM: [V3, V3][] = [
  [[7, 6, 0], [9, 9, 6]],
  [[7, 12, 0], [9, 15, 6]],
]
const WALL_POST = box([4, 0, 4], [12, 16, 12])
const WALL_ARM_LOW: [V3, V3] = [[5, 0, 0], [11, 14, 8]]
const WALL_ARM_TALL: [V3, V3] = [[5, 0, 0], [11, 16, 8]]

const SIDES = ['north', 'east', 'south', 'west'] as const

// --- flat plants and cross plants -------------------------------------------
const flat = (height: number): Shape => ({ boxes: [box([0, 0, 0], [16, height, 16])] })

/** Plants whose texture name is not simply the block name. */
const CROSS_TEX: Record<string, string> = {
  grass: 'short_grass',
  sweet_berry_bush: 'sweet_berry_bush_stage3',
}

const CROSS_PLANTS = new Set([
  'fern',
  'short_grass',
  'grass',
  'bush',
  'poppy',
  'dandelion',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'torchflower',
  'dead_bush',
  'brown_mushroom',
  'red_mushroom',
  'sweet_berry_bush',
  'crimson_roots',
  'warped_roots',
  'nether_sprouts',
  'cactus_flower',
])

/** Two-block-tall plants: `half` picks the _top / _bottom texture. */
const TALL_PLANTS = new Set(['tall_grass', 'large_fern', 'rose_bush', 'peony', 'lilac', 'sunflower'])

function crossFor(base: string, props: Props): string[] | null {
  if (TALL_PLANTS.has(base)) {
    return [`${base}_${props['half'] === 'upper' ? 'top' : 'bottom'}`]
  }
  if (base.endsWith('_sapling')) return [base]
  // Growth-stage crops: vanilla draws these as four parallel flat quads; the
  // cross is a close enough stand-in and costs one code path instead of two.
  if (base === 'wheat') return [`wheat_stage${props['age'] ?? '7'}`]
  if (base === 'nether_wart') return [`nether_wart_stage${props['age'] ?? '2'}`]
  if (CROSS_PLANTS.has(base)) return [CROSS_TEX[base] ?? base]
  return null
}

/** Flat quads hugging whichever faces the block says it is attached to. */
const LICHEN_BOX: Record<Face, [V3, V3]> = {
  nz: [[0, 0, 0.1], [16, 16, 0.1]],
  pz: [[0, 0, 15.9], [16, 16, 15.9]],
  nx: [[0.1, 0, 0], [0.1, 16, 16]],
  px: [[15.9, 0, 0], [15.9, 16, 16]],
  ny: [[0, 0.1, 0], [16, 0.1, 16]],
  py: [[0, 15.9, 0], [16, 15.9, 16]],
}
const LICHEN_SIDE: Record<string, Face> = {
  north: 'nz',
  south: 'pz',
  east: 'px',
  west: 'nx',
  up: 'py',
  down: 'ny',
}

/**
 * The shape of one block state, or null when it is a full cube (the greedy
 * mesher's fast path). `base` is a namespace-free block name.
 */
export function shapeFor(base: string, props: Props): Shape | null {
  const cross = crossFor(base, props)
  if (cross) return { boxes: [], cross }

  if (base.endsWith('_slab')) {
    const type = props['type'] ?? 'bottom'
    if (type === 'double') return null
    return { boxes: [type === 'top' ? box([0, 8, 0], [16, 16, 16]) : box([0, 0, 0], [16, 8, 16])] }
  }

  if (base.endsWith('_stairs')) {
    const step = STEP[props['shape'] ?? 'straight'] ?? STEP['straight']!
    return oriented([box([0, 0, 0], [16, 8, 16]), ...step.map(([f, t]) => box(f, t))], props)
  }

  if (base.endsWith('_trapdoor')) {
    // Open: the panel stands on the side opposite `facing` (it is hinged on the
    // block it is attached to), the same for either half.
    if (props['open'] === 'true') return oriented([box([0, 0, 0], [3, 16, 16])], props, false)
    return oriented([box([0, 0, 0], [16, 3, 16])], props)
  }

  if (base.endsWith('_fence_gate')) {
    const boxes = [box([7, 5, 0], [9, 16, 2]), box([7, 5, 14], [9, 16, 16])]
    // ponytail: an open gate is just its two posts; model the swung halves only
    // if open gates ever look wrong enough to care about.
    if (props['open'] !== 'true') {
      boxes.push(box([7, 6, 2], [9, 9, 14]), box([7, 12, 2], [9, 15, 14]))
    }
    return oriented(boxes, props, false)
  }

  if (base.endsWith('_fence')) {
    const boxes = [FENCE_POST]
    for (const side of SIDES) {
      if (props[side] !== 'true') continue
      for (const [f, t] of FENCE_ARM) boxes.push(turnBox(box(f, t), SIDE_TURNS[side]!))
    }
    return { boxes }
  }

  if (base.endsWith('_wall')) {
    const boxes: Box[] = []
    for (const side of SIDES) {
      const how = props[side] ?? 'none'
      if (how === 'none') continue
      const [f, t] = how === 'tall' ? WALL_ARM_TALL : WALL_ARM_LOW
      boxes.push(turnBox(box(f, t), SIDE_TURNS[side]!))
    }
    // `up` defaults to true, and a wall with no arms is always a post.
    if (props['up'] !== 'false' || boxes.length === 0) boxes.unshift(WALL_POST)
    return { boxes }
  }

  if (base.endsWith('_carpet') || base === 'leaf_litter') return flat(1)

  if (base.endsWith('_shelf')) return oriented([box([0, 0, 0], [6, 16, 16])], props, false)

  switch (base) {
    case 'snow': {
      const layers = Number(props['layers'] ?? '1')
      return flat(2 * (Number.isFinite(layers) ? Math.min(8, Math.max(1, layers)) : 1))
    }
    case 'farmland':
    case 'dirt_path':
      return flat(15)
    case 'chest':
    case 'trapped_chest':
      // Vanilla draws chests as block entities; a boxy stand-in is close enough.
      return { boxes: [box([1, 0, 1], [15, 14, 15])] }
    case 'glow_lichen': {
      const boxes: Box[] = []
      for (const [prop, face] of Object.entries(LICHEN_SIDE)) {
        if (props[prop] !== 'true') continue
        const [f, t] = LICHEN_BOX[face]
        boxes.push({ from: f, to: t, tex: base })
      }
      return boxes.length > 0 ? { boxes } : null
    }
    default:
      return null
  }
}
