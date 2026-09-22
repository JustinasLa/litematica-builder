// Minimal hand-rolled PNG encode/decode used only by tests, plus stubs for the
// browser decode path (createImageBitmap + OffscreenCanvas) that Node lacks.
// encodePng only ever produces 8-bit RGBA, filter-type-0 (none) scanlines --
// that is all our own fixtures need. decodePng is the general side: it also
// has to read real vanilla PNGs out of public/default-pack.zip, which are
// greyscale or palette-indexed with non-zero row filters, so it supports all
// five PNG filter types and colour types 0/2/3/4/6 at 8-bit depth.
import { deflateSync, inflateSync, crc32 } from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/** Encode a raw RGBA buffer (width*height*4 bytes) as a valid PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter type: none
    for (let x = 0; x < stride; x++) raw[rowStart + 1 + x] = rgba[y * stride + x]
  }
  const idat = deflateSync(raw)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Channel count per pixel for each PNG colour type, at 8-bit depth. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Undo the five PNG scanline filters in place, given the previous unfiltered row. */
function unfilterRow(row: Uint8Array, prev: Uint8Array | null, bpp: number): void {
  const type = row[0]!
  for (let x = 1; x < row.length; x++) {
    const a = x - bpp >= 1 ? row[x - bpp]! : 0
    const b = prev ? prev[x]! : 0
    const c = prev && x - bpp >= 1 ? prev[x - bpp]! : 0
    switch (type) {
      case 0:
        break
      case 1:
        row[x] = (row[x]! + a) & 0xff
        break
      case 2:
        row[x] = (row[x]! + b) & 0xff
        break
      case 3:
        row[x] = (row[x]! + ((a + b) >> 1)) & 0xff
        break
      case 4:
        row[x] = (row[x]! + paeth(a, b, c)) & 0xff
        break
      default:
        throw new Error(`unsupported PNG filter type ${type}`)
    }
  }
}

/**
 * Decode an 8-bit-depth PNG of colour type 0 (grey), 2 (RGB), 3 (palette, with
 * optional tRNS alpha), 4 (grey+alpha) or 6 (RGBA), any of the five row
 * filters. Covers both our own encodePng fixtures and real vanilla textures.
 */
export function decodePng(bytes: Uint8Array): {
  width: number
  height: number
  data: Uint8ClampedArray
} {
  const buf = Buffer.from(bytes)
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  let palette: Buffer = Buffer.alloc(0)
  let trns: Buffer = Buffer.alloc(0)
  const idatChunks: Buffer[] = []
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]!
      colorType = data[9]!
      if (bitDepth !== 8) throw new Error(`test PNG decoder only supports 8-bit depth, got ${bitDepth}`)
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      trns = Buffer.from(data)
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idatChunks))
  const channels = CHANNELS[colorType]!
  const stride = width * channels
  const data = new Uint8ClampedArray(width * height * 4)
  // tRNS on colour types 0/2 is a single "this exact sample is transparent"
  // key, not a per-pixel alpha channel: one 16-bit grey sample, or one 16-bit
  // RGB triple. At 8-bit depth the meaningful byte is the low byte.
  const greyKey = colorType === 0 && trns.length >= 2 ? trns.readUInt16BE(0) & 0xff : -1
  const rgbKey: [number, number, number] | null =
    colorType === 2 && trns.length >= 6
      ? [trns.readUInt16BE(0) & 0xff, trns.readUInt16BE(2) & 0xff, trns.readUInt16BE(4) & 0xff]
      : null
  let prev: Uint8Array | null = null
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const row = new Uint8Array(raw.subarray(rowStart, rowStart + stride + 1))
    unfilterRow(row, prev, channels)
    prev = row
    for (let x = 0; x < width; x++) {
      const s = 1 + x * channels
      const d = (y * width + x) * 4
      switch (colorType) {
        case 0: {
          const g = row[s]!
          data[d] = g
          data[d + 1] = g
          data[d + 2] = g
          data[d + 3] = g === greyKey ? 0 : 255
          break
        }
        case 2: {
          const r = row[s]!
          const g = row[s + 1]!
          const b = row[s + 2]!
          data[d] = r
          data[d + 1] = g
          data[d + 2] = b
          data[d + 3] = rgbKey && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2] ? 0 : 255
          break
        }
        case 3: {
          const i = row[s]!
          data[d] = palette[i * 3]!
          data[d + 1] = palette[i * 3 + 1]!
          data[d + 2] = palette[i * 3 + 2]!
          data[d + 3] = i < trns.length ? trns[i]! : 255
          break
        }
        case 4: {
          const g = row[s]!
          data[d] = g
          data[d + 1] = g
          data[d + 2] = g
          data[d + 3] = row[s + 1]!
          break
        }
        default: // 6, RGBA
          data[d] = row[s]!
          data[d + 1] = row[s + 1]!
          data[d + 2] = row[s + 2]!
          data[d + 3] = row[s + 3]!
      }
    }
  }
  return { width, height, data }
}

/**
 * Install `createImageBitmap` + `OffscreenCanvas` stubs backed by decodePng,
 * so src/textures.ts's browser-only decode path works against Node test
 * fixtures. Safe to call multiple times (idempotent overwrite).
 */
export function installPngDecodeStubs(): void {
  class FakeCtx {
    buf: Uint8ClampedArray
    constructor(w: number, h: number) {
      this.buf = new Uint8ClampedArray(w * h * 4)
    }
    drawImage(bitmap: { data: Uint8ClampedArray }) {
      this.buf.set(bitmap.data)
    }
    getImageData() {
      return { data: this.buf }
    }
  }
  class FakeOffscreenCanvas {
    w: number
    h: number
    constructor(w: number, h: number) {
      this.w = w
      this.h = h
    }
    getContext() {
      return new FakeCtx(this.w, this.h)
    }
  }
  ;(globalThis as unknown as Record<string, unknown>).OffscreenCanvas = FakeOffscreenCanvas
  ;(globalThis as unknown as Record<string, unknown>).createImageBitmap = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const decoded = decodePng(bytes)
    return { width: decoded.width, height: decoded.height, data: decoded.data, close() {} }
  }
}
