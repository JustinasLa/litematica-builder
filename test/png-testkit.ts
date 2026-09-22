// Minimal hand-rolled PNG encode/decode used only by tests, plus stubs for the
// browser decode path (createImageBitmap + OffscreenCanvas) that Node lacks.
// Only supports what src/textures.ts itself produces/consumes: 8-bit RGBA,
// filter-type-0 (none) scanlines. That is all we ever feed it, since we are
// both the encoder and the "browser" decoding it back.
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

/** Decode a PNG produced by encodePng (or any 8-bit RGBA, filter-0 PNG). */
export function decodePng(bytes: Uint8Array): {
  width: number
  height: number
  data: Uint8ClampedArray
} {
  const buf = Buffer.from(bytes)
  let offset = 8
  let width = 0
  let height = 0
  const idatChunks: Buffer[] = []
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idatChunks))
  const stride = width * 4
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    if (raw[rowStart] !== 0) throw new Error('test PNG decoder only supports filter type 0')
    for (let x = 0; x < stride; x++) data[y * stride + x] = raw[rowStart + 1 + x]
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
