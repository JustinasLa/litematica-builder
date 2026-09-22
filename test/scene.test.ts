import { describe, expect, it } from 'vitest'
import { meshSchematic, SUB } from '../src/scene'
import type { Region, Schematic } from '../src/litematic'
import { fallbackTextures } from '../src/textures'

function regionOf(sizeX: number, sizeY: number, sizeZ: number, name = 'stone'): Region {
  const size = { x: sizeX, y: sizeY, z: sizeZ }
  const blocks = new Uint32Array(sizeX * sizeY * sizeZ) // all index 0
  return {
    name: 'test',
    min: { x: 0, y: 0, z: 0 },
    size,
    palette: [{ name, properties: {} }],
    blocks,
    getBlock: (x, y, z) => blocks[y * sizeX * sizeZ + z * sizeX + x]!,
  }
}

function schematicOf(region: Region): Schematic {
  return {
    name: 'test',
    author: 'test',
    description: '',
    size: region.size,
    totalBlocks: region.blocks.length,
    regionCount: 1,
    regions: [region],
  }
}

function meshAll(schematic: Schematic, chunkSize?: number) {
  // meshSchematic is a generator; the chunkSize guard only runs once iteration
  // starts, so spreading it is what actually exercises the throw.
  return [...meshSchematic(schematic, fallbackTextures(), chunkSize)]
}

describe('meshSchematic: chunkSize guard', () => {
  const schematic = schematicOf(regionOf(1, 1, 1))

  it('throws a RangeError when chunkSize * 256 > 0xffff', () => {
    expect(() => meshAll(schematic, 256)).toThrow(RangeError)
  })

  it('throws a RangeError when chunkSize <= 0', () => {
    expect(() => meshAll(schematic, 0)).toThrow(RangeError)
    expect(() => meshAll(schematic, -1)).toThrow(RangeError)
  })

  it('still works at chunkSize 32 (the default) and 255 (the max)', () => {
    expect(() => meshAll(schematic, 32)).not.toThrow()
    expect(() => meshAll(schematic, 255)).not.toThrow()
  })
})

describe('meshSchematic: greedy-path uv orientation', () => {
  const chunks = meshAll(schematicOf(regionOf(1, 1, 1)))
  // A single, unshaped stone block: every face is its own quad (nothing to
  // merge), one chunk, six quads.
  const chunk = chunks[0]!

  function verticesOfFace(normal: [number, number, number]): { pos: number[]; uv: number[] }[] {
    const out: { pos: number[]; uv: number[] }[] = []
    for (let i = 0; i < chunk.normals.length / 3; i++) {
      const n = [chunk.normals[i * 3]!, chunk.normals[i * 3 + 1]!, chunk.normals[i * 3 + 2]!]
      const matches = normal.every((c, a) => Math.sign(n[a]!) === Math.sign(c) && (c !== 0 || n[a] === 0))
      if (matches) {
        out.push({
          pos: [chunk.positions[i * 3]!, chunk.positions[i * 3 + 1]!, chunk.positions[i * 3 + 2]!],
          uv: [chunk.tileUv[i * 2]!, chunk.tileUv[i * 2 + 1]!],
        })
      }
    }
    return out
  }

  it('+y (top) face: the vertex with the smallest v has z=0 (texture north edge at -z)', () => {
    const verts = verticesOfFace([0, 1, 0])
    expect(verts.length).toBe(4)
    const minV = Math.min(...verts.map((p) => p.uv[1]!))
    for (const v of verts) {
      if (v.uv[1] === minV) expect(v.pos[2]).toBe(0)
    }
  })

  it('-z (north) face: the vertex with v=0 is at the top (max y)', () => {
    const verts = verticesOfFace([0, 0, -1])
    expect(verts.length).toBe(4)
    const maxY = Math.max(...verts.map((p) => p.pos[1]!))
    for (const v of verts) {
      if (v.uv[1] === 0) expect(v.pos[1]).toBe(maxY)
    }
  })
})

describe('meshSchematic: merged quad uvs', () => {
  it('a 3x1x2 stone region merges into a quad whose uv spans [0, 3*16] x [0, 2*16] on some face', () => {
    const chunks = meshAll(schematicOf(regionOf(3, 1, 2)))
    let found = false
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.tileUv.length / 2 / 4; i++) {
        const us = [0, 1, 2, 3].map((c) => chunk.tileUv[(i * 4 + c) * 2]!)
        const vs = [0, 1, 2, 3].map((c) => chunk.tileUv[(i * 4 + c) * 2 + 1]!)
        const uSpan = Math.max(...us) - Math.min(...us)
        const vSpan = Math.max(...vs) - Math.min(...vs)
        if (
          (uSpan === 3 * 16 && vSpan === 2 * 16) ||
          (uSpan === 2 * 16 && vSpan === 3 * 16)
        ) {
          found = true
        }
      }
    }
    expect(found).toBe(true)
  })
})
