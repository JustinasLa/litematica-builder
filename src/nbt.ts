// Read-only big-endian Java NBT reader. No writer is in scope.
//
// Tag payload -> JS value mapping. The JS type is the tag-type info a caller
// needs: ByteArray -> Int8Array, IntArray -> Int32Array, LongArray ->
// BigInt64Array, Long -> bigint. Everything else is number/string/array/object.

export type NbtValue =
  | number
  | bigint
  | string
  | Int8Array
  | Int32Array
  | BigInt64Array
  | NbtValue[]
  | NbtCompound

export interface NbtCompound {
  [key: string]: NbtValue
}

const TAG_END = 0
const TAG_COMPOUND = 10

class Reader {
  private readonly view: DataView
  private readonly bytes: Uint8Array
  private pos = 0

  constructor(data: ArrayBuffer | Uint8Array) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
  }

  private need(n: number): number {
    const at = this.pos
    if (at + n > this.bytes.byteLength) {
      throw new Error(`Truncated NBT data: wanted ${n} byte(s) at offset ${at}`)
    }
    this.pos = at + n
    return at
  }

  u8(): number {
    return this.view.getUint8(this.need(1))
  }

  i8(): number {
    return this.view.getInt8(this.need(1))
  }

  i16(): number {
    return this.view.getInt16(this.need(2), false)
  }

  u16(): number {
    return this.view.getUint16(this.need(2), false)
  }

  i32(): number {
    return this.view.getInt32(this.need(4), false)
  }

  i64(): bigint {
    return this.view.getBigInt64(this.need(8), false)
  }

  f32(): number {
    return this.view.getFloat32(this.need(4), false)
  }

  f64(): number {
    return this.view.getFloat64(this.need(8), false)
  }

  string(): string {
    const len = this.u16()
    const at = this.need(len)
    return decodeModifiedUtf8(this.bytes.subarray(at, at + len))
  }

  payload(type: number): NbtValue {
    switch (type) {
      case 1:
        return this.i8()
      case 2:
        return this.i16()
      case 3:
        return this.i32()
      case 4:
        return this.i64()
      case 5:
        return this.f32()
      case 6:
        return this.f64()
      case 7: {
        const len = this.checkedLength()
        const at = this.need(len)
        return new Int8Array(this.bytes.buffer.slice(this.bytes.byteOffset + at, this.bytes.byteOffset + at + len))
      }
      case 8:
        return this.string()
      case 9: {
        const elementType = this.u8()
        const len = this.checkedLength()
        const out: NbtValue[] = []
        if (elementType === TAG_END) {
          if (len > 0) throw new Error(`NBT list of TAG_End with length ${len}`)
          return out
        }
        for (let i = 0; i < len; i++) out.push(this.payload(elementType))
        return out
      }
      case TAG_COMPOUND: {
        const out: NbtCompound = {}
        for (;;) {
          const childType = this.u8()
          if (childType === TAG_END) return out
          const name = this.string()
          out[name] = this.payload(childType)
        }
      }
      case 11: {
        const len = this.checkedLength()
        const out = new Int32Array(len)
        for (let i = 0; i < len; i++) out[i] = this.i32()
        return out
      }
      case 12: {
        const len = this.checkedLength()
        const out = new BigInt64Array(len)
        for (let i = 0; i < len; i++) out[i] = this.i64()
        return out
      }
      default:
        throw new Error(`Unknown NBT tag type ${type} at offset ${this.pos - 1}`)
    }
  }

  private checkedLength(): number {
    const len = this.i32()
    if (len < 0) throw new Error(`Negative NBT array/list length ${len}`)
    return len
  }
}

/** Java's "modified UTF-8": 1-3 byte forms only, NUL encoded as C0 80. */
function decodeModifiedUtf8(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const a = bytes[i++]!
    if (a < 0x80) {
      out += String.fromCharCode(a)
    } else if ((a & 0xe0) === 0xc0) {
      const b = bytes[i++]
      if (b === undefined) throw new Error('Truncated modified-UTF-8 sequence')
      out += String.fromCharCode(((a & 0x1f) << 6) | (b & 0x3f))
    } else if ((a & 0xf0) === 0xe0) {
      const b = bytes[i++]
      const c = bytes[i++]
      if (b === undefined || c === undefined) throw new Error('Truncated modified-UTF-8 sequence')
      out += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f))
    } else {
      throw new Error(`Invalid modified-UTF-8 lead byte 0x${a.toString(16)}`)
    }
  }
  return out
}

/** Parse decompressed NBT. The root must be a named compound. */
export function parseNbt(data: ArrayBuffer | Uint8Array): { name: string; value: NbtCompound } {
  const r = new Reader(data)
  const type = r.u8()
  if (type !== TAG_COMPOUND) {
    throw new Error(`Not NBT data: root tag type is ${type}, expected 10 (compound)`)
  }
  const name = r.string()
  return { name, value: r.payload(TAG_COMPOUND) as NbtCompound }
}
