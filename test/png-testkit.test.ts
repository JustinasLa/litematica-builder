// Unit tests for the test-only PNG decoder itself (test/png-testkit.ts). This
// decoder is what test/textures.test.ts relies on to assert real vanilla
// cutout textures (palette/greyscale, filtered scanlines) actually decode
// with transparent texels -- if the decoder silently mis-decoded a filter or
// colour type, that assertion would pass for the wrong reason (or throw and
// get masked into an all-opaque fallback, which is exactly the bug this
// decoder exists to catch).
import { unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodePng } from './png-testkit'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function paethForward(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Hand-build a single-channel (greyscale) PNG whose N rows each use a
 * different filter type in turn (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth),
 * cycling if there are more rows than filter types. `rows` are the *raw*
 * (unfiltered) pixel values the decoder should recover exactly.
 */
function buildGreyPng(rows: number[][]): Uint8Array {
  const width = rows[0]!.length
  const height = rows.length
  const stride = width
  const raw = Buffer.alloc((stride + 1) * height)
  let prevRaw: number[] | null = null
  for (let y = 0; y < height; y++) {
    const filterType = y % 5
    const row = rows[y]!
    const rowStart = y * (stride + 1)
    raw[rowStart] = filterType
    for (let x = 0; x < width; x++) {
      const val = row[x]!
      const a = x > 0 ? row[x - 1]! : 0
      const b = prevRaw ? prevRaw[x]! : 0
      const c = prevRaw && x > 0 ? prevRaw[x - 1]! : 0
      let encoded: number
      switch (filterType) {
        case 0:
          encoded = val
          break
        case 1:
          encoded = val - a
          break
        case 2:
          encoded = val - b
          break
        case 3:
          encoded = val - ((a + b) >> 1)
          break
        default:
          encoded = val - paethForward(a, b, c)
      }
      raw[rowStart + 1 + x] = encoded & 0xff
    }
    prevRaw = row
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

describe('decodePng: hand-built fixtures', () => {
  it('round-trips a 4x4 greyscale image through all five row filters', () => {
    const rows = [
      [10, 20, 30, 40], // filter 0: None
      [15, 25, 35, 45], // filter 1: Sub
      [5, 100, 200, 250], // filter 2: Up
      [0, 255, 128, 64], // filter 3: Average
      [42, 42, 200, 1], // filter 4: Paeth
    ]
    const png = buildGreyPng(rows)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(4)
    expect(decoded.height).toBe(5)
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < 4; x++) {
        const d = (y * 4 + x) * 4
        const expected = rows[y]![x]!
        expect([decoded.data[d], decoded.data[d + 1], decoded.data[d + 2], decoded.data[d + 3]]).toEqual([
          expected,
          expected,
          expected,
          255,
        ])
      }
    }
  })

  it('decodes a greyscale PNG with a tRNS transparent-colour key (colour type 0)', () => {
    // 2x2 image, grey value 100 is the transparent key; only one pixel matches.
    const width = 2
    const height = 2
    const trns = Buffer.alloc(2)
    trns.writeUInt16BE(100, 0)
    const raw = Buffer.from([0, 100, 50, 0, 50, 50]) // row0: filter0,100,50; row1: filter0,50,50
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8
    ihdr[9] = 0 // colour type: greyscale
    const png = new Uint8Array(
      Buffer.concat([
        SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('tRNS', trns),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    )
    const decoded = decodePng(png)
    expect(decoded.width).toBe(2)
    expect(decoded.height).toBe(2)
    // Pixel (0,0) = grey 100 -> matches the tRNS key -> alpha 0.
    expect([...decoded.data.subarray(0, 4)]).toEqual([100, 100, 100, 0])
    // The other three pixels (grey 50) do not match -> alpha 255.
    expect([...decoded.data.subarray(4, 8)]).toEqual([50, 50, 50, 255])
    expect([...decoded.data.subarray(8, 12)]).toEqual([50, 50, 50, 255])
    expect([...decoded.data.subarray(12, 16)]).toEqual([50, 50, 50, 255])
  })

  it('decodes a palette PNG with tRNS alpha (colour type 3)', () => {
    // 2x1 image, palette index 0 = opaque red, index 1 = transparent green.
    const width = 2
    const height = 1
    const palette = Buffer.from([255, 0, 0, 0, 255, 0])
    const trns = Buffer.from([255, 0])
    const raw = Buffer.from([0, 0, 1]) // filter none, index 0, index 1
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8
    ihdr[9] = 3 // colour type: palette
    const png = new Uint8Array(
      Buffer.concat([
        SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('PLTE', palette),
        chunk('tRNS', trns),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    )
    const decoded = decodePng(png)
    expect([...decoded.data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    expect([...decoded.data.subarray(4, 8)]).toEqual([0, 255, 0, 0])
  })
})

describe('decodePng: real vanilla textures from public/default-pack.zip', () => {
  const packPath = fileURLToPath(new URL('../public/default-pack.zip', import.meta.url))
  const files = unzipSync(new Uint8Array(readFileSync(packPath)))

  it('decodes stone.png (greyscale/RGB, no transparency) as 16x16', () => {
    const decoded = decodePng(files['assets/minecraft/textures/block/stone.png']!)
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
    for (let i = 3; i < decoded.data.length; i += 4) expect(decoded.data[i]).toBe(255)
  })

  it('decodes fern.png (palette + tRNS) as 16x16 with alpha-0 texels', () => {
    const decoded = decodePng(files['assets/minecraft/textures/block/fern.png']!)
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
    let sawTransparent = false
    for (let i = 3; i < decoded.data.length; i += 4) {
      if (decoded.data[i] === 0) {
        sawTransparent = true
        break
      }
    }
    expect(sawTransparent).toBe(true)
  })

  it('decodes grass_block_top.png as 16x16', () => {
    const decoded = decodePng(files['assets/minecraft/textures/block/grass_block_top.png']!)
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
  })
})
