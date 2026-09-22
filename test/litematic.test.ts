import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseNbt } from '../src/nbt'
import {
  bitsPerEntryFor,
  gunzip,
  loadLitematic,
  normaliseRegion,
  readBitEntry,
} from '../src/litematic'
import { isAir } from '../src/blocks'

const hillPath = fileURLToPath(new URL('../Hill.litematic', import.meta.url))
const hillBytes = readFileSync(hillPath)

describe('bitsPerEntryFor', () => {
  it('is exact at powers of two and never below 2', () => {
    expect(bitsPerEntryFor(1)).toBe(2)
    expect(bitsPerEntryFor(2)).toBe(2)
    expect(bitsPerEntryFor(4)).toBe(2)
    expect(bitsPerEntryFor(5)).toBe(3)
    expect(bitsPerEntryFor(8)).toBe(3)
    expect(bitsPerEntryFor(9)).toBe(4)
    expect(bitsPerEntryFor(256)).toBe(8)
    expect(bitsPerEntryFor(257)).toBe(9)
    expect(bitsPerEntryFor(1 << 20)).toBe(20)
  })
})

describe('readBitEntry', () => {
  it('reads 3-bit entries including one straddling two longs', () => {
    // 3 bits/entry: entry 21 occupies bits 63..65, straddling longs 0 and 1.
    // Pack entries 0..41 as (i % 8) little-end-first into two longs.
    const longs = new BigInt64Array(2)
    let acc = [0n, 0n]
    for (let i = 0; i < 42; i++) {
      const v = BigInt(i % 8)
      const off = i * 3
      acc[Math.floor(off / 64)]! |= (v << BigInt(off % 64)) & 0xffffffffffffffffn
      if (Math.floor(off / 64) !== Math.floor((off + 2) / 64)) {
        acc[Math.floor((off + 2) / 64)]! |= v >> BigInt(64 - (off % 64))
      }
    }
    longs[0] = BigInt.asIntN(64, acc[0]!)
    longs[1] = BigInt.asIntN(64, acc[1]!)

    for (let i = 0; i < 42; i++) {
      expect(readBitEntry(longs, 3, i)).toBe(i % 8)
    }
    // Entry 21 really does straddle: bits 63,64,65.
    expect(Math.floor((21 * 3) / 64)).toBe(0)
    expect(Math.floor((21 * 3 + 2) / 64)).toBe(1)
  })

  it('matches hand-computed 5-bit values across a long boundary', () => {
    // long0 = all ones, long1 = 0. Entry 12 covers bits 60..64:
    // low 4 bits from long0 (1111), top bit from long1 (0) -> 0b01111 = 15.
    const longs = new BigInt64Array([BigInt.asIntN(64, 0xffffffffffffffffn), 0n])
    expect(readBitEntry(longs, 5, 0)).toBe(31)
    expect(readBitEntry(longs, 5, 11)).toBe(31) // bits 55..59, wholly in long0
    expect(readBitEntry(longs, 5, 12)).toBe(15)
    expect(readBitEntry(longs, 5, 13)).toBe(0)
  })

  it('does not sign-extend when the high bit of a long is set', () => {
    // A negative (as signed) long must be treated as unsigned.
    const longs = new BigInt64Array([-1n, -1n])
    expect(readBitEntry(longs, 7, 9)).toBe(127) // bits 63..69, straddling
  })
})

describe('normaliseRegion', () => {
  it('leaves positive sizes alone', () => {
    expect(normaliseRegion({ x: 3, y: 4, z: 5 }, { x: 2, y: 2, z: 2 })).toEqual({
      min: { x: 3, y: 4, z: 5 },
      size: { x: 2, y: 2, z: 2 },
    })
  })

  it('flips negative axes to a min corner plus positive extent', () => {
    // Size -3 at Position 10 covers 10, 9, 8 -> min 8, extent 3.
    expect(normaliseRegion({ x: 10, y: 0, z: -5 }, { x: -3, y: 1, z: -2 })).toEqual({
      min: { x: 8, y: 0, z: -6 },
      size: { x: 3, y: 1, z: 2 },
    })
  })
})

describe('Hill.litematic round-trip', () => {
  it('parses and agrees with its own metadata', async () => {
    const schematic = await loadLitematic(hillBytes)
    const root = parseNbt(await gunzip(hillBytes)).value as Record<string, unknown>
    const meta = root['Metadata'] as Record<string, unknown>

    expect(schematic.regions.length).toBe(meta['RegionCount'])
    expect(schematic.regionCount).toBe(schematic.regions.length)

    let nonAir = 0
    let volume = 0
    let maxIndexOverrun = 0
    for (const region of schematic.regions) {
      const count = region.size.x * region.size.y * region.size.z
      expect(region.blocks.length).toBe(count)
      volume += count
      const air = region.palette.map((b) => isAir(b.name))
      // Hot loop: no per-block expect(), it costs minutes on 3.8M blocks.
      for (const index of region.blocks) {
        if (index >= region.palette.length) maxIndexOverrun++
        else if (!air[index]) nonAir++
      }
    }
    expect(maxIndexOverrun).toBe(0)

    expect(volume).toBe(meta['TotalVolume'])
    // The real test of the straddling bit-unpacker.
    expect(nonAir).toBe(schematic.totalBlocks)
    expect(schematic.totalBlocks).toBe(meta['TotalBlocks'])
  })

  it('rejects non-gzip input with a readable error', async () => {
    await expect(loadLitematic(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/gzip/)
  })
})
