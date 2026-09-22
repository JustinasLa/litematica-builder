import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shapeFor, type Box, type Shape } from '../src/shapes'
import { isOpaque } from '../src/blocks'
import { loadLitematic } from '../src/litematic'
import type { Region, Schematic } from '../src/litematic'
import { meshSchematic } from '../src/scene'
import { fallbackTextures } from '../src/textures'

const hillPath = fileURLToPath(new URL('../Hill.litematic', import.meta.url))
const hillBytes = readFileSync(hillPath)

// --- geometry helpers --------------------------------------------------------

function assertValidBox(b: Box): void {
  for (let i = 0; i < 3; i++) {
    expect(Number.isFinite(b.from[i])).toBe(true)
    expect(Number.isFinite(b.to[i])).toBe(true)
    expect(b.from[i]).toBeGreaterThanOrEqual(0)
    expect(b.from[i]).toBeLessThanOrEqual(16)
    expect(b.to[i]).toBeGreaterThanOrEqual(0)
    expect(b.to[i]).toBeLessThanOrEqual(16)
    // Boxes are ordered from<=to on every axis; a lichen/lichen-style quad is
    // flat (from===to) on exactly its own normal axis.
    expect(b.to[i]).toBeGreaterThanOrEqual(b.from[i])
  }
}

function assertValidShape(shape: Shape | null): void {
  expect(shape).not.toBeNull()
  for (const b of shape!.boxes) assertValidBox(b)
  if (shape!.cross) {
    for (const tex of shape!.cross) {
      expect(typeof tex).toBe('string')
      expect(tex.length).toBeGreaterThan(0)
    }
  }
}

// --- synthetic-region helpers, for testing the emitted cullface flag via the
// real mesher (shapes.ts itself does not expose the cull bit) ---------------

function columnRegion(states: { name: string; properties?: Record<string, string> }[]): Region {
  const size = { x: 1, y: states.length, z: 1 }
  const palette = states.map((s) => ({ name: s.name, properties: s.properties ?? {} }))
  const blocks = Uint32Array.from(states.map((_, i) => i))
  return {
    name: 'test',
    min: { x: 0, y: 0, z: 0 },
    size,
    palette,
    blocks,
    getBlock: (_x, y, _z) => blocks[y]!,
  }
}

/** Same idea, but neighbours line up along x instead of y. */
function rowRegion(states: { name: string; properties?: Record<string, string> }[]): Region {
  const size = { x: states.length, y: 1, z: 1 }
  const palette = states.map((s) => ({ name: s.name, properties: s.properties ?? {} }))
  const blocks = Uint32Array.from(states.map((_, i) => i))
  return {
    name: 'test',
    min: { x: 0, y: 0, z: 0 },
    size,
    palette,
    blocks,
    getBlock: (x, _y, _z) => blocks[x]!,
  }
}

function totalQuads(region: Region): number {
  const schematic: Schematic = {
    name: 'test',
    author: 'test',
    description: '',
    size: region.size,
    totalBlocks: region.blocks.length,
    regionCount: 1,
    regions: [region],
  }
  let quads = 0
  for (const chunk of meshSchematic(schematic, fallbackTextures())) quads += chunk.quads
  return quads
}

// --- 1. invariants over every family -----------------------------------------

describe('shapeFor: geometry invariants per family', () => {
  const FACINGS = ['north', 'east', 'south', 'west']
  const HALVES = ['bottom', 'top']
  const STAIR_SHAPES = ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right']

  it('slab: bottom, top, double', () => {
    for (const type of ['bottom', 'top', 'double']) {
      const shape = shapeFor('stone_brick_slab', { type })
      if (type === 'double') expect(shape).toBeNull()
      else assertValidShape(shape)
    }
  })

  it('stairs: every facing x half x shape', () => {
    for (const facing of FACINGS) {
      for (const half of HALVES) {
        for (const shape of STAIR_SHAPES) {
          assertValidShape(shapeFor('oak_stairs', { facing, half, shape }))
        }
      }
    }
  })

  it('trapdoor: every facing x half x open', () => {
    for (const facing of FACINGS) {
      for (const half of HALVES) {
        for (const open of ['true', 'false']) {
          assertValidShape(shapeFor('oak_trapdoor', { facing, half, open }))
        }
      }
    }
  })

  it('fence: every single-arm and the all-arms combo', () => {
    const sides = ['north', 'east', 'south', 'west']
    for (const side of sides) {
      const props = Object.fromEntries(sides.map((s) => [s, s === side ? 'true' : 'false']))
      assertValidShape(shapeFor('oak_fence', props))
    }
    assertValidShape(shapeFor('oak_fence', { north: 'true', east: 'true', south: 'true', west: 'true' }))
    assertValidShape(shapeFor('oak_fence', { north: 'false', east: 'false', south: 'false', west: 'false' }))
  })

  it('wall: none/low/tall sides x up true/false', () => {
    for (const how of ['none', 'low', 'tall']) {
      for (const up of ['true', 'false']) {
        assertValidShape(
          shapeFor('cobblestone_wall', { north: how, east: 'none', south: 'none', west: 'none', up }),
        )
      }
    }
  })

  it('carpet', () => {
    assertValidShape(shapeFor('red_carpet', {}))
  })

  it('snow: layers 1..7 are shaped; layer 8 is a full cube (null)', () => {
    for (let n = 1; n <= 7; n++) assertValidShape(shapeFor('snow', { layers: String(n) }))
    expect(shapeFor('snow', { layers: '8' })).toBeNull()
  })

  it('farmland and dirt_path', () => {
    assertValidShape(shapeFor('farmland', {}))
    assertValidShape(shapeFor('dirt_path', {}))
  })

  it('glow_lichen on several faces', () => {
    for (const face of ['north', 'south', 'east', 'west', 'up', 'down']) {
      assertValidShape(shapeFor('glow_lichen', { [face]: 'true' }))
    }
    assertValidShape(
      shapeFor('glow_lichen', { north: 'true', south: 'true', up: 'true', down: 'true' }),
    )
  })

  it('chest', () => {
    assertValidShape(shapeFor('chest', {}))
  })

  it('cross plants', () => {
    for (const name of ['fern', 'short_grass', 'poppy', 'dead_bush', 'red_mushroom']) {
      assertValidShape(shapeFor(name, {}))
    }
  })

  it('two-tall plants, top and bottom halves', () => {
    for (const half of ['upper', 'lower']) {
      assertValidShape(shapeFor('tall_grass', { half }))
    }
  })

  it('never throws and never returns NaN geometry for any property combination', () => {
    // A denser cross-product smoke pass across families, catching combinations
    // the named cases above missed.
    const bases = [
      'stone_brick_slab',
      'oak_stairs',
      'oak_trapdoor',
      'oak_fence',
      'oak_fence_gate',
      'cobblestone_wall',
      'red_carpet',
      'snow',
      'glow_lichen',
    ]
    const propSets: Record<string, string>[] = [
      {},
      { type: 'top', facing: 'south', half: 'top', shape: 'inner_left', open: 'true' },
      { north: 'true', south: 'low', east: 'tall', west: 'true', up: 'false', layers: '4' },
    ]
    for (const base of bases) {
      for (const props of propSets) {
        expect(() => shapeFor(base, props)).not.toThrow()
        const shape = shapeFor(base, props)
        // glow_lichen with no side property set to 'true' legitimately has no
        // faces to draw (never occurs in real data, where it always attaches
        // to at least one face) -- null is the correct answer there, not a bug.
        if (base === 'glow_lichen' && shape === null) continue
        assertValidShape(shape)
      }
    }
  })
})

// --- 2. orientation -----------------------------------------------------------

describe('shapeFor: orientation', () => {
  it('slab: bottom occupies y 0..8, top occupies y 8..16, double is a full cube', () => {
    const bottom = shapeFor('stone_brick_slab', { type: 'bottom' })!
    expect(bottom.boxes).toEqual([{ from: [0, 0, 0], to: [16, 8, 16] }])

    const top = shapeFor('stone_brick_slab', { type: 'top' })!
    expect(top.boxes).toEqual([{ from: [0, 8, 0], to: [16, 16, 16] }])

    expect(shapeFor('stone_brick_slab', { type: 'double' })).toBeNull()
    expect(isOpaque('minecraft:stone_brick_slab', { type: 'double' })).toBe(true)
    expect(isOpaque('minecraft:stone_brick_slab', { type: 'bottom' })).toBe(false)
  })

  describe('stairs: facing=east, half=bottom, shape=straight', () => {
    const shape = shapeFor('oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' })!

    it('has a full-width base at y 0..8 and a step with x extent 8..16', () => {
      expect(shape.boxes).toContainEqual({ from: [0, 0, 0], to: [16, 8, 16] })
      expect(shape.boxes).toContainEqual({ from: [8, 8, 0], to: [16, 16, 16] })
    })
  })

  it('stairs: facing=west straight step has x extent 0..8', () => {
    const shape = shapeFor('oak_stairs', { facing: 'west', half: 'bottom', shape: 'straight' })!
    expect(shape.boxes).toContainEqual({ from: [0, 8, 0], to: [8, 16, 16] })
  })

  it('stairs: facing=south straight step has z extent 8..16', () => {
    const shape = shapeFor('oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' })!
    expect(shape.boxes).toContainEqual({ from: [0, 8, 8], to: [16, 16, 16] })
  })

  it('stairs: facing=north straight step has z extent 0..8', () => {
    const shape = shapeFor('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' })!
    expect(shape.boxes).toContainEqual({ from: [0, 8, 0], to: [16, 16, 8] })
  })

  it('stairs: half=top mirrors the base and step in y', () => {
    const shape = shapeFor('oak_stairs', { facing: 'east', half: 'top', shape: 'straight' })!
    expect(shape.boxes).toContainEqual({ from: [0, 8, 0], to: [16, 16, 16] }) // base, y 8..16
    expect(shape.boxes).toContainEqual({ from: [8, 0, 0], to: [16, 8, 16] }) // step, y 0..8
  })

  it('stairs: facing=east outer_right keeps only the south-east quarter of the step', () => {
    const shape = shapeFor('oak_stairs', { facing: 'east', half: 'bottom', shape: 'outer_right' })!
    expect(shape.boxes).toContainEqual({ from: [0, 0, 0], to: [16, 8, 16] }) // base
    expect(shape.boxes).toContainEqual({ from: [8, 8, 8], to: [16, 16, 16] }) // SE quarter
    expect(shape.boxes).toHaveLength(2)
  })

  it('stairs: facing=east inner_right has the east half plus the south-west quarter', () => {
    const shape = shapeFor('oak_stairs', { facing: 'east', half: 'bottom', shape: 'inner_right' })!
    expect(shape.boxes).toContainEqual({ from: [0, 0, 0], to: [16, 8, 16] }) // base
    expect(shape.boxes).toContainEqual({ from: [8, 8, 0], to: [16, 16, 16] }) // east half
    expect(shape.boxes).toContainEqual({ from: [0, 8, 8], to: [8, 16, 16] }) // SW quarter
    expect(shape.boxes).toHaveLength(3)
  })

  it('trapdoor: half=bottom open=false is y 0..3; half=top open=false is y 13..16', () => {
    const bottom = shapeFor('oak_trapdoor', { facing: 'east', half: 'bottom', open: 'false' })!
    expect(bottom.boxes).toEqual([{ from: [0, 0, 0], to: [16, 3, 16] }])

    const top = shapeFor('oak_trapdoor', { facing: 'east', half: 'top', open: 'false' })!
    expect(top.boxes).toEqual([{ from: [0, 13, 0], to: [16, 16, 16] }])
  })

  it('trapdoor: open=true is a 3-thick vertical panel on the facing side', () => {
    // facing=east -> panel on the +x side, x 13..16 (vanilla stores the
    // clicked face, and the panel stands up against that side).
    const east = shapeFor('oak_trapdoor', { facing: 'east', half: 'bottom', open: 'true' })!
    expect(east.boxes).toEqual([{ from: [13, 0, 0], to: [16, 16, 16] }])

    // facing=west -> panel on the -x side, x 0..3.
    const west = shapeFor('oak_trapdoor', { facing: 'west', half: 'bottom', open: 'true' })!
    expect(west.boxes).toEqual([{ from: [0, 0, 0], to: [3, 16, 16] }])
  })

  it('fence: centre post is always x,z in 6..10; arms appear only for true sides and reach that edge', () => {
    const post: Box = { from: [6, 0, 6], to: [10, 16, 10] }
    const none = shapeFor('oak_fence', { north: 'false', east: 'false', south: 'false', west: 'false' })!
    expect(none.boxes).toEqual([post])

    const north = shapeFor('oak_fence', { north: 'true', east: 'false', south: 'false', west: 'false' })!
    expect(north.boxes[0]).toEqual(post)
    expect(north.boxes).toHaveLength(3)
    // North arms are authored to reach z=0, the block's own north edge.
    for (const b of north.boxes.slice(1)) expect(b.from[2]).toBe(0)

    const east = shapeFor('oak_fence', { north: 'false', east: 'true', south: 'false', west: 'false' })!
    // East arms (one quarter turn from north) reach the +x edge, x=16.
    for (const b of east.boxes.slice(1)) expect(b.to[0]).toBe(16)
  })

  it('wall: up=true gives a centre post; north=low gives a low arm, north=tall gives a full arm', () => {
    const post: Box = { from: [4, 0, 4], to: [12, 16, 12] }

    const up = shapeFor('cobblestone_wall', {
      north: 'none',
      east: 'none',
      south: 'none',
      west: 'none',
      up: 'true',
    })!
    expect(up.boxes).toEqual([post])

    const low = shapeFor('cobblestone_wall', {
      north: 'low',
      east: 'none',
      south: 'none',
      west: 'none',
      up: 'false',
    })!
    expect(low.boxes).toContainEqual({ from: [5, 0, 0], to: [11, 14, 8] })

    const tall = shapeFor('cobblestone_wall', {
      north: 'tall',
      east: 'none',
      south: 'none',
      west: 'none',
      up: 'false',
    })!
    expect(tall.boxes).toContainEqual({ from: [5, 0, 0], to: [11, 16, 8] })
  })

  it('snow: height is 2*layers for layers 1..7', () => {
    for (let n = 1; n <= 7; n++) {
      const shape = shapeFor('snow', { layers: String(n) })!
      expect(shape.boxes).toEqual([{ from: [0, 0, 0], to: [16, 2 * n, 16] }])
    }
  })

  it('snow: layers=8 is a full cube, so isOpaque reports true', () => {
    expect(shapeFor('snow', { layers: '8' })).toBeNull()
    expect(isOpaque('minecraft:snow', { layers: '8' })).toBe(true)
  })

  it('farmland and dirt_path top out at y=15', () => {
    expect(shapeFor('farmland', {})!.boxes).toEqual([{ from: [0, 0, 0], to: [16, 15, 16] }])
    expect(shapeFor('dirt_path', {})!.boxes).toEqual([{ from: [0, 0, 0], to: [16, 15, 16] }])
  })

  it('two-tall plants: half=upper references the _top texture, half=lower the _bottom', () => {
    expect(shapeFor('tall_grass', { half: 'upper' })!.cross).toEqual(['tall_grass_top'])
    expect(shapeFor('tall_grass', { half: 'lower' })!.cross).toEqual(['tall_grass_bottom'])
  })

  it('door: closed panel sits on the side opposite facing', () => {
    // facing=east -> opposite is west -> panel at x 0..3.
    const east = shapeFor('oak_door', { facing: 'east', half: 'lower' })!
    expect(east.boxes).toEqual([{ from: [0, 0, 0], to: [3, 16, 16], tex: 'oak_door_bottom' }])

    // facing=north -> opposite is south -> panel at z 13..16.
    const north = shapeFor('oak_door', { facing: 'north', half: 'lower' })!
    expect(north.boxes).toEqual([{ from: [0, 0, 13], to: [16, 16, 16], tex: 'oak_door_bottom' }])
  })

  it('door: half selects the _top / _bottom texture', () => {
    expect(shapeFor('oak_door', { facing: 'east', half: 'upper' })!.boxes[0]!.tex).toBe('oak_door_top')
    expect(shapeFor('oak_door', { facing: 'east', half: 'lower' })!.boxes[0]!.tex).toBe('oak_door_bottom')
  })

  it('door: open panel swings to the hinge edge, facing=east', () => {
    const left = shapeFor('oak_door', { facing: 'east', half: 'lower', open: 'true', hinge: 'left' })!
    expect(left.boxes).toEqual([{ from: [0, 0, 0], to: [16, 16, 3], tex: 'oak_door_bottom' }])

    const right = shapeFor('oak_door', { facing: 'east', half: 'lower', open: 'true', hinge: 'right' })!
    expect(right.boxes).toEqual([{ from: [0, 0, 13], to: [16, 16, 16], tex: 'oak_door_bottom' }])
  })
})

// --- 2b. new shape families (torch, ladder, button, pressure plate, lantern,
// chain, signs, barrier, unattached glow_lichen) --------------------------

describe('shapeFor: torch, ladder, button, pressure plate, lantern, chain, signs', () => {
  it('torch / soul_torch / redstone_torch: a post at x,z 7..9, y 0..10', () => {
    for (const name of ['torch', 'soul_torch', 'redstone_torch']) {
      const shape = shapeFor(name, {})!
      assertValidShape(shape)
      expect(shape.boxes).toEqual([{ from: [7, 0, 7], to: [9, 10, 9], tex: name }])
    }
  })

  it('wall_torch: sits against the wall opposite facing, textured as the plain torch', () => {
    const east = shapeFor('wall_torch', { facing: 'east' })!
    expect(east.boxes).toHaveLength(1)
    expect(east.boxes[0]!.tex).toBe('torch')
    expect(east.boxes[0]!.from[0]).toBeGreaterThanOrEqual(0)
    expect(east.boxes[0]!.to[0]).toBeLessThanOrEqual(3)

    const south = shapeFor('wall_torch', { facing: 'south' })!
    expect(south.boxes[0]!.from[2]).toBeGreaterThanOrEqual(0)
    expect(south.boxes[0]!.to[2]).toBeLessThanOrEqual(3)

    const west = shapeFor('wall_torch', { facing: 'west' })!
    expect(west.boxes[0]!.from[0]).toBeGreaterThanOrEqual(13)
    expect(west.boxes[0]!.to[0]).toBeLessThanOrEqual(16)
  })

  it('ladder: a thin panel against the wall opposite facing', () => {
    const east = shapeFor('ladder', { facing: 'east' })!
    expect(east.boxes[0]!.from[0]).toBeGreaterThanOrEqual(0)
    expect(east.boxes[0]!.to[0]).toBeLessThanOrEqual(1)

    const west = shapeFor('ladder', { facing: 'west' })!
    expect(west.boxes[0]!.from[0]).toBeGreaterThanOrEqual(15)
    expect(west.boxes[0]!.to[0]).toBeLessThanOrEqual(16)
  })

  it('button: floor and ceiling heights, and a 6x4 in-plane footprint', () => {
    const floor = shapeFor('stone_button', { face: 'floor' })!
    expect(floor.boxes).toEqual([{ from: [6, 0, 5], to: [10, 2, 11] }])
    expect(Math.abs(floor.boxes[0]!.to[0] - floor.boxes[0]!.from[0])).toBe(4)
    expect(Math.abs(floor.boxes[0]!.to[2] - floor.boxes[0]!.from[2])).toBe(6)

    const ceiling = shapeFor('stone_button', { face: 'ceiling' })!
    expect(ceiling.boxes).toEqual([{ from: [6, 14, 5], to: [10, 16, 11] }])
  })

  it('button: face=wall sits against the wall opposite facing', () => {
    const east = shapeFor('stone_button', { face: 'wall', facing: 'east' })!
    expect(east.boxes[0]!.from[0]).toBeGreaterThanOrEqual(0)
    expect(east.boxes[0]!.to[0]).toBeLessThanOrEqual(2)
  })

  it('pressure_plate: exact footprint [1,0,1] to [15,1,15]', () => {
    expect(shapeFor('stone_pressure_plate', {})!.boxes).toEqual([{ from: [1, 0, 1], to: [15, 1, 15] }])
  })

  it('lantern / soul_lantern: box centred in x/z, y 0..7 grounded and y 2..9 hanging', () => {
    for (const name of ['lantern', 'soul_lantern']) {
      const grounded = shapeFor(name, { hanging: 'false' })!
      expect(grounded.boxes).toEqual([{ from: [5, 0, 5], to: [11, 7, 11], tex: name }])
      const hanging = shapeFor(name, { hanging: 'true' })!
      expect(hanging.boxes).toEqual([{ from: [5, 2, 5], to: [11, 9, 11], tex: name }])
    }
  })

  it('sea_lantern and jack_o_lantern are full cubes (null)', () => {
    expect(shapeFor('sea_lantern', {})).toBeNull()
    expect(shapeFor('jack_o_lantern', {})).toBeNull()
  })

  it('chain: a 2x16x2 post running along its axis', () => {
    const y = shapeFor('chain', { axis: 'y' })!
    expect(y.boxes).toEqual([{ from: [7, 0, 7], to: [9, 16, 9], tex: 'chain' }])
    const x = shapeFor('chain', { axis: 'x' })!
    expect(x.boxes).toEqual([{ from: [0, 7, 7], to: [16, 9, 9], tex: 'chain' }])
    const z = shapeFor('chain', { axis: 'z' })!
    expect(z.boxes).toEqual([{ from: [7, 7, 0], to: [9, 9, 16], tex: 'chain' }])
  })

  it('signs: standing sign is a panel on a post, textured with the parent planks', () => {
    const sign = shapeFor('spruce_sign', { facing: 'east' })!
    for (const b of sign.boxes) expect(b.tex).toBe('spruce_planks')
    expect(sign.boxes.length).toBeGreaterThanOrEqual(2)
    // The post sits centred in x/z and starts at the block's own floor.
    expect(sign.boxes.some((b) => b.from[1] === 0)).toBe(true)
  })

  it('signs: wall sign is a panel against the wall opposite facing', () => {
    const sign = shapeFor('spruce_wall_sign', { facing: 'east' })!
    expect(sign.boxes).toHaveLength(1)
    expect(sign.boxes[0]!.tex).toBe('spruce_planks')
    expect(sign.boxes[0]!.from[0]).toBeGreaterThanOrEqual(0)
    expect(sign.boxes[0]!.to[0]).toBeLessThanOrEqual(2)
  })

  it('signs: hanging sign has a panel near the top, textured with the parent planks', () => {
    const sign = shapeFor('spruce_hanging_sign', { facing: 'east' })!
    for (const b of sign.boxes) expect(b.tex).toBe('spruce_planks')
    expect(sign.boxes.some((b) => b.to[1] >= 14)).toBe(true)
  })

  it('barrier and unattached glow_lichen: a present-but-invisible shape with zero boxes', () => {
    expect(shapeFor('barrier', {})).toEqual({ boxes: [] })
    expect(shapeFor('glow_lichen', {})).toEqual({ boxes: [] })
    expect(isOpaque('minecraft:barrier', {})).toBe(false)
    expect(isOpaque('minecraft:glow_lichen', {})).toBe(false)
  })

  it('every box from these families is inside [0,16] on every axis', () => {
    const shapes = [
      shapeFor('torch', {}),
      shapeFor('wall_torch', { facing: 'east' }),
      shapeFor('ladder', { facing: 'east' }),
      shapeFor('stone_button', { face: 'wall', facing: 'east' }),
      shapeFor('stone_pressure_plate', {}),
      shapeFor('lantern', { hanging: 'true' }),
      shapeFor('chain', { axis: 'x' }),
      shapeFor('spruce_sign', { facing: 'east' }),
      shapeFor('spruce_wall_sign', { facing: 'east' }),
      shapeFor('spruce_hanging_sign', { facing: 'east' }),
    ]
    for (const s of shapes) assertValidShape(s)
  })

  it('is deterministic across repeated calls', () => {
    const props = { facing: 'east', hanging: 'true' }
    expect(shapeFor('lantern', props)).toEqual(shapeFor('lantern', props))
    expect(shapeFor('chain', { axis: 'x' })).toEqual(shapeFor('chain', { axis: 'x' }))
    expect(shapeFor('spruce_sign', { facing: 'east' })).toEqual(shapeFor('spruce_sign', { facing: 'east' }))
  })
})

// --- 3. cullface derivation, through the real mesher --------------------------

describe('cullface derivation (via meshSchematic)', () => {
  it('the bottom face of a bottom slab is cullable: dropped against an opaque neighbour, kept against a non-opaque one', () => {
    // Full-cube neighbour below a bottom slab. `stone` is opaque, `glass` is
    // not, and both are full, unshaped cubes so their own emitted quad count
    // is identical in both cases (their only neighbour, the slab above, is
    // never opaque). Only the slab's own down face should differ.
    const opaqueBelow = totalQuads(
      columnRegion([{ name: 'stone' }, { name: 'stone_brick_slab', properties: { type: 'bottom' } }]),
    )
    const transparentBelow = totalQuads(
      columnRegion([{ name: 'glass' }, { name: 'stone_brick_slab', properties: { type: 'bottom' } }]),
    )
    expect(transparentBelow - opaqueBelow).toBe(1)
  })

  it('the top face of a bottom slab (y=8) is not cullable: unaffected by an opaque block above', () => {
    const withAirBelow = (above: string) =>
      totalQuads(
        columnRegion([
          { name: 'air' },
          { name: 'stone_brick_slab', properties: { type: 'bottom' } },
          { name: above },
        ]),
      )
    expect(withAirBelow('stone')).toBe(withAirBelow('glass'))
  })

  it('the stairs base bottom face is cullable', () => {
    const props = { facing: 'east', half: 'bottom', shape: 'straight' }
    const opaqueBelow = totalQuads(columnRegion([{ name: 'stone' }, { name: 'oak_stairs', properties: props }]))
    const transparentBelow = totalQuads(
      columnRegion([{ name: 'glass' }, { name: 'oak_stairs', properties: props }]),
    )
    expect(transparentBelow - opaqueBelow).toBe(1)
  })

  it('a fence post side is not cullable: identical quad count regardless of an adjacent opaque block', () => {
    // Fence post's own x/z side faces sit at x,z in 6..10, never touching a
    // block edge (0 or 16), so they should never depend on the neighbour.
    // Compare across an opaque vs. non-opaque neighbour to the east (+x);
    // stacking along y instead would also flex the post's own top/bottom
    // faces, which *are* on the y boundary and so are a separate case.
    const east = (name: string) => totalQuads(rowRegion([{ name: 'oak_fence' }, { name }]))
    expect(east('stone')).toBe(east('glass'))
  })

  it('a carpet bottom face is cullable, its top face is not', () => {
    const opaqueBelow = totalQuads(columnRegion([{ name: 'stone' }, { name: 'red_carpet' }]))
    const transparentBelow = totalQuads(columnRegion([{ name: 'glass' }, { name: 'red_carpet' }]))
    expect(transparentBelow - opaqueBelow).toBe(1) // bottom face cullable

    const withAirBelow = (above: string) =>
      totalQuads(columnRegion([{ name: 'air' }, { name: 'red_carpet' }, { name: above }]))
    expect(withAirBelow('stone')).toBe(withAirBelow('glass')) // top face not cullable
  })
})

// --- 4. isOpaque ---------------------------------------------------------------

describe('isOpaque', () => {
  it('reports true for real full-cube Hill palette names', () => {
    for (const name of ['stone', 'dirt', 'spruce_log', 'moss_block']) {
      expect(isOpaque(`minecraft:${name}`), name).toBe(true)
    }
  })

  it('reports false for shaped, thin, or non-solid Hill palette names', () => {
    const cases: [string, Record<string, string>?][] = [
      ['stone_brick_slab', { type: 'bottom' }],
      ['dark_oak_stairs'],
      ['spruce_fence'],
      ['spruce_trapdoor'],
      ['fern'],
      ['short_grass'],
      ['cobblestone_wall'],
      ['moss_carpet'],
      ['snow', { layers: '3' }],
      ['farmland'],
      ['glow_lichen', { up: 'true' }],
      ['water'],
      ['spruce_leaves'],
      ['glass'],
      ['air'],
    ]
    for (const [name, props] of cases) {
      expect(isOpaque(`minecraft:${name}`, props), name).toBe(false)
    }
  })

  it('reports true for a double slab (a full cube again)', () => {
    expect(isOpaque('minecraft:stone_brick_slab', { type: 'double' })).toBe(true)
  })
})

// --- 5. integration against the real Hill.litematic fixture -------------------

describe('shapeFor and isOpaque against Hill.litematic', () => {
  it('every shaped palette entry reports isOpaque === false, and no shape throws or leaves [0,16]', async () => {
    const schematic = await loadLitematic(hillBytes)
    let shapedCount = 0
    for (const region of schematic.regions) {
      for (const { name, properties } of region.palette) {
        const base = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
        let shape: Shape | null = null
        expect(() => {
          shape = shapeFor(base, properties)
        }).not.toThrow()
        if (shape === null) continue
        shapedCount++
        expect(isOpaque(name, properties), name).toBe(false)
        for (const b of shape!.boxes) assertValidBox(b)
      }
    }
    // The implementer measured ~60 distinct shaped states across the fixture.
    expect(shapedCount).toBeGreaterThan(20)
  })
})

// --- 6. determinism -------------------------------------------------------------

describe('determinism', () => {
  it('shapeFor gives deep-equal output for repeated identical input', () => {
    const props = { facing: 'south', half: 'top', shape: 'inner_left' }
    const a = shapeFor('oak_stairs', props)
    const b = shapeFor('oak_stairs', props)
    expect(a).toEqual(b)
  })

  it('one facing does not mutate the box tables used by another facing', () => {
    const east1 = shapeFor('oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' })
    shapeFor('oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' })
    shapeFor('oak_stairs', { facing: 'west', half: 'top', shape: 'outer_left' })
    const east2 = shapeFor('oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' })
    expect(east2).toEqual(east1)
  })

  it('fence shapes for different sides do not share mutated arm arrays', () => {
    const north = shapeFor('oak_fence', { north: 'true', east: 'false', south: 'false', west: 'false' })
    shapeFor('oak_fence', { north: 'false', east: 'true', south: 'false', west: 'false' })
    shapeFor('oak_fence', { north: 'false', east: 'false', south: 'true', west: 'false' })
    const north2 = shapeFor('oak_fence', { north: 'true', east: 'false', south: 'false', west: 'false' })
    expect(north2).toEqual(north)
  })
})
