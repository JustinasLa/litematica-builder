import { parseNbt, type NbtCompound, type NbtValue } from './nbt'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface BlockState {
  name: string
  properties: Record<string, string>
}

export interface Region {
  name: string
  /** Normalised minimum corner in schematic space. */
  min: Vec3
  /** Positive extents. */
  size: Vec3
  palette: BlockState[]
  /** Palette index per block, indexed by y*(sizeX*sizeZ) + z*sizeX + x. */
  blocks: Uint32Array
  getBlock(x: number, y: number, z: number): number
}

export interface Schematic {
  name: string
  author: string
  description: string
  /** Metadata.EnclosingSize. */
  size: Vec3
  /** Metadata.TotalBlocks. */
  totalBlocks: number
  regionCount: number
  regions: Region[]
}

const U64 = 0xffffffffffffffffn

/** Litematica: max(2, ceil(log2(paletteSize))), computed without floats. */
export function bitsPerEntryFor(paletteSize: number): number {
  if (paletteSize <= 1) return 2
  return Math.max(2, 32 - Math.clz32(paletteSize - 1))
}

/**
 * LitematicaBitArray read: entries may straddle the boundary between two
 * longs (the pre-1.16 packing), unlike modern chunk sections.
 */
export function readBitEntry(longs: BigInt64Array, bitsPerEntry: number, index: number): number {
  const startOffset = index * bitsPerEntry
  const startArrIndex = Math.floor(startOffset / 64)
  const endArrIndex = Math.floor((startOffset + bitsPerEntry - 1) / 64)
  const startBitOffset = BigInt(startOffset % 64)
  const mask = (1n << BigInt(bitsPerEntry)) - 1n

  const start = BigInt.asUintN(64, longs[startArrIndex]!)
  if (startArrIndex === endArrIndex) {
    return Number((start >> startBitOffset) & mask)
  }
  const end = BigInt.asUintN(64, longs[endArrIndex]!)
  const value = ((start >> startBitOffset) | ((end << (64n - startBitOffset)) & U64)) & mask
  return Number(value)
}

/**
 * Normalise a region's Position/Size. Litematica may store a negative Size on
 * any axis, meaning the region extends in the negative direction.
 */
export function normaliseRegion(pos: Vec3, size: Vec3): { min: Vec3; size: Vec3 } {
  const axis = (p: number, s: number) => (s < 0 ? p + s + 1 : p)
  return {
    min: { x: axis(pos.x, size.x), y: axis(pos.y, size.y), z: axis(pos.z, size.z) },
    size: { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) },
  }
}

/** Decompression cap: a crafted gzip bomb must not OOM the tab. */
const MAX_DECOMPRESSED = 512 * 1024 * 1024

/** Per-region block cap: 64M entries is a 256 MB Uint32Array, ~16x the Hill fixture. */
const MAX_REGION_BLOCKS = 64 * 1024 * 1024

export async function gunzip(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  // Copy into an ArrayBuffer-backed view so it is a valid BlobPart.
  const bytes = new Uint8Array(data)
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error('Not a .litematic file: missing gzip header (expected 1f 8b).')
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_DECOMPRESSED) {
      await reader.cancel()
      throw new Error(`Schematic too large (over ${MAX_DECOMPRESSED / (1024 * 1024)} MB decompressed)`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** Gunzip + parse + normalise a .litematic file. */
export async function loadLitematic(data: ArrayBuffer | Uint8Array): Promise<Schematic> {
  return parseLitematic(parseNbt(await gunzip(data)).value)
}

export function parseLitematic(root: NbtCompound): Schematic {
  const meta = asCompound(root['Metadata']) ?? {}
  const regionsTag = asCompound(root['Regions'])
  if (!regionsTag) {
    throw new Error('Not a Litematica schematic: no "Regions" compound in the NBT root.')
  }

  const regions = Object.entries(regionsTag).map(([name, value]) => {
    const region = asCompound(value)
    if (!region) throw new Error(`Region "${name}" is not a compound.`)
    return parseRegion(name, region)
  })
  if (regions.length === 0) {
    throw new Error('Not a Litematica schematic: "Regions" is empty.')
  }

  return {
    name: asString(meta['Name']) || 'Unnamed',
    author: asString(meta['Author']),
    description: asString(meta['Description']),
    size: readVec3(asCompound(meta['EnclosingSize'])) ?? enclosingSizeOf(regions),
    totalBlocks: asNumber(meta['TotalBlocks']),
    regionCount: asNumber(meta['RegionCount']) || regions.length,
    regions,
  }
}

function parseRegion(name: string, region: NbtCompound): Region {
  const pos = readVec3(asCompound(region['Position']))
  const rawSize = readVec3(asCompound(region['Size']))
  if (!pos || !rawSize) {
    throw new Error(`Region "${name}" is missing Position or Size.`)
  }
  const { min, size } = normaliseRegion(pos, rawSize)
  const entryCount = checkedEntryCount(name, size)

  const paletteTag = region['BlockStatePalette']
  if (!Array.isArray(paletteTag) || paletteTag.length === 0) {
    throw new Error(`Region "${name}" has an empty or missing BlockStatePalette.`)
  }
  const palette: BlockState[] = paletteTag.map((entry, i) => {
    const c = asCompound(entry)
    const blockName = c ? asString(c['Name']) : ''
    if (!blockName) throw new Error(`Region "${name}" palette entry ${i} has no Name.`)
    const props: Record<string, string> = {}
    const propsTag = c ? asCompound(c['Properties']) : undefined
    if (propsTag) {
      for (const [k, v] of Object.entries(propsTag)) props[k] = asString(v)
    }
    return { name: blockName, properties: props }
  })

  const states = region['BlockStates']
  if (!(states instanceof BigInt64Array)) {
    throw new Error(`Region "${name}" has no BlockStates long array.`)
  }

  const bits = bitsPerEntryFor(palette.length)
  const expected = Math.ceil((entryCount * bits) / 64)
  if (states.length < expected) {
    throw new Error(
      `Region "${name}": BlockStates length ${states.length} does not match ` +
        `${entryCount} blocks at ${bits} bits/entry (expected ${expected} longs).`,
    )
  }

  const blocks = new Uint32Array(entryCount)
  for (let i = 0; i < entryCount; i++) {
    const index = readBitEntry(states, bits, i)
    if (index >= palette.length) {
      throw new Error(
        `Region "${name}": block ${i} has palette index ${index}, ` +
          `outside a palette of ${palette.length} entries.`,
      )
    }
    blocks[i] = index
  }

  const strideZ = size.x
  const strideY = size.x * size.z
  return {
    name,
    min,
    size,
    palette,
    blocks,
    getBlock: (x, y, z) => blocks[y * strideY + z * strideZ + x]!,
  }
}

/**
 * Block count of a region, validated before anything is allocated from it: a
 * crafted Size is a trust boundary just like the decompressed byte count.
 */
function checkedEntryCount(name: string, size: Vec3): number {
  for (const axis of ['x', 'y', 'z'] as const) {
    const n = size[axis]
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`Region "${name}" has a non-positive or invalid ${axis} size (${n}).`)
    }
  }
  const count = size.x * size.y * size.z
  if (!Number.isSafeInteger(count) || count > MAX_REGION_BLOCKS) {
    throw new Error(
      `Region "${name}" is too large (${size.x}x${size.y}x${size.z} = ${count} blocks, ` +
        `limit ${MAX_REGION_BLOCKS.toLocaleString('en-US')}).`,
    )
  }
  return count
}

function enclosingSizeOf(regions: Region[]): Vec3 {
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const r of regions) {
    for (const a of ['x', 'y', 'z'] as const) {
      lo[a] = Math.min(lo[a], r.min[a])
      hi[a] = Math.max(hi[a], r.min[a] + r.size[a])
    }
  }
  return { x: hi.x - lo.x, y: hi.y - lo.y, z: hi.z - lo.z }
}

function asCompound(v: NbtValue | undefined): NbtCompound | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)
    ? (v as NbtCompound)
    : undefined
}

function asString(v: NbtValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

function asNumber(v: NbtValue | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return 0
}

function readVec3(c: NbtCompound | undefined): Vec3 | undefined {
  if (!c) return undefined
  const { x, y, z } = c
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined
  return { x, y, z }
}
