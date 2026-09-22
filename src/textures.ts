// Block textures loaded from a Minecraft client .jar or a resource-pack .zip
// the *user* supplies. No Mojang asset is shipped or served by this app.
// Without a pack we fall back to the flat colours in blocks.ts.

import * as THREE from 'three'
import { unzip, type UnzipFileInfo } from 'fflate'
import { baseName, blockColour } from './blocks'

export type Face = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz'

export interface BlockTextures {
  /** three.js DataArrayTexture holding every distinct block-face image, one per layer. */
  readonly texture: THREE.DataArrayTexture
  /** Edge length in pixels of each layer (all layers are square and identical in size). */
  readonly tileSize: number
  /** Layer index into `texture` for this block name + face. Always valid; never -1. */
  layer(blockName: string, face: Face): number
  /** Multiplicative tint as 0xRRGGBB (0xffffff when untinted) — grass/foliage/water need it. */
  tint(blockName: string, face: Face): number
  /**
   * Stable id such that two faces may be merged by the greedy mesher iff their keys are equal.
   * Must fold in layer, tint, and any render-flag that affects appearance.
   */
  faceKey(blockName: string, face: Face): number
  /**
   * Resolve an explicit vanilla texture name (what shapes.ts names its faces
   * with). Falls back to `blockName`'s flat colour when the pack lacks it.
   */
  ref(textureName: string, blockName: string): { layer: number; tint: number; key: number }
}

// --- trust boundary: a dropped file is arbitrary input ----------------------
// Same spirit as MAX_DECOMPRESSED in litematic.ts: a zip bomb must produce a
// readable error, never a hang or an unbounded allocation.

/** Largest pack file we will even read into memory. */
const MAX_PACK_BYTES = 512 * 1024 * 1024
/** Largest total of inflated block PNGs. A client jar's block/ dir is ~10 MB. */
const MAX_TEXTURE_BYTES = 64 * 1024 * 1024
/** Largest single PNG. A 512x animated strip is well under this. */
const MAX_PNG_BYTES = 8 * 1024 * 1024
/** WebGL2 guarantees at least 256 array layers; 2048 is the common real limit. */
const MAX_LAYERS = 2048
/** Downscale anything bigger: a 128x pack would otherwise cost 65 MB of RAM. */
const MAX_TILE = 64
/** Hard ceiling on the atlas allocation, layers are dropped to stay under it. */
const MAX_ATLAS_BYTES = 96 * 1024 * 1024

// --- fixed plains-biome tints (no real biome colormaps) ---------------------
const GRASS_TINT = 0x91bd59
const FOLIAGE_TINT = 0x77ab2f
const WATER_TINT = 0x3f76e4
const UNTINTED = 0xffffff

/** Layer 0 is a solid white tile: every unresolved face points at it and is
 *  tinted with its flat blockColour, which is why layer() never returns -1. */
const WHITE_LAYER = 0

/** A face's image: a pack texture, optionally with a tinted overlay baked on. */
interface Ref {
  name: string
  overlay?: string
  /** Tint applied at render time (the overlay's own tint is baked in). */
  tint: number
}

type Slot = 'top' | 'bottom' | 'side'

const SIDE_OF: Record<Face, Slot> = {
  px: 'side',
  nx: 'side',
  pz: 'side',
  nz: 'side',
  py: 'top',
  ny: 'bottom',
}

/** Blocks whose faces the generic `<name>[_top|_bottom|_side]` guess gets wrong. */
const SPECIAL: Record<string, Partial<Record<Slot, Ref>>> = {
  grass_block: {
    top: { name: 'grass_block_top', tint: GRASS_TINT },
    side: { name: 'grass_block_side', overlay: 'grass_block_side_overlay', tint: UNTINTED },
    bottom: { name: 'dirt', tint: UNTINTED },
  },
  podzol: { bottom: { name: 'dirt', tint: UNTINTED } },
  mycelium: { bottom: { name: 'dirt', tint: UNTINTED } },
  dirt_path: { bottom: { name: 'dirt', tint: UNTINTED } },
  farmland: { side: { name: 'dirt', tint: UNTINTED }, bottom: { name: 'dirt', tint: UNTINTED } },
  crafting_table: { bottom: { name: 'oak_planks', tint: UNTINTED } },
  smooth_sandstone: { side: { name: 'sandstone_top', tint: UNTINTED } },
  smooth_red_sandstone: { side: { name: 'red_sandstone_top', tint: UNTINTED } },
}

/** Leaves that are already coloured in the pack and must not be tinted. */
const UNTINTED_LEAVES = new Set(['cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves'])

/** Greyscale plants that take the grass tint. */
const GRASS_TINTED = new Set([
  'grass',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'vine',
  'sugar_cane',
  'lily_pad',
])

/** Layers we bake by alpha-blending a tinted overlay onto a base texture. */
const COMPOSITES: { base: string; overlay: string; tint: number }[] = [
  { base: 'grass_block_side', overlay: 'grass_block_side_overlay', tint: GRASS_TINT },
]

const layerKeyOf = (ref: Ref): string => (ref.overlay ? `${ref.name}|${ref.overlay}` : ref.name)

/** Blocks made *of* another block: they borrow that block's textures. */
const MATERIAL_SUFFIX = [
  '_slab',
  '_stairs',
  '_wall',
  '_fence_gate',
  '_fence',
  '_button',
  '_pressure_plate',
]

/** Texture stems for a block, most specific first, before any per-face suffix. */
function stemsOf(base: string): string[] {
  // Wood/hyphae reuse the log/stem texture on every face.
  if (base.endsWith('_wood')) return [`${base.slice(0, -5)}_log`]
  if (base.endsWith('_hyphae')) return [`${base.slice(0, -7)}_stem`]
  if (base === 'water') return ['water_still']
  if (base === 'lava') return ['lava_still']
  if (base === 'grass') return ['short_grass']
  for (const suffix of MATERIAL_SUFFIX) {
    if (!base.endsWith(suffix)) continue
    // stone_brick_slab -> stone_bricks, spruce_slab -> spruce_planks.
    const stem = base.slice(0, -suffix.length)
    return [base, stem, `${stem}s`, `${stem}_planks`]
  }
  return [base]
}

function tintOf(base: string): number {
  if (base === 'water') return WATER_TINT
  if (base.endsWith('_leaves') && !UNTINTED_LEAVES.has(base)) return FOLIAGE_TINT
  if (GRASS_TINTED.has(base)) return GRASS_TINT
  return UNTINTED
}

/** Tint for an explicit texture name: `large_fern_top` takes the grass tint. */
function tintOfTexture(name: string): number {
  const direct = tintOf(name)
  if (direct !== UNTINTED) return direct
  const stripped = name.replace(/_(top|bottom|side|stage\d+)$/, '')
  return stripped === name ? UNTINTED : tintOf(stripped)
}

/**
 * Pick the pack texture for one face. Pragmatic, model-JSON-free: try the
 * obvious names in order and give up (null) rather than guessing wildly.
 * ponytail: no block model parsing; add it if stairs/doors/facing look wrong.
 */
function resolveFace(base: string, slot: Slot, has: (name: string) => boolean): Ref | null {
  const special = SPECIAL[base]?.[slot]
  if (special) return has(special.name) ? special : null

  const tint = tintOf(base)
  const candidates = stemsOf(base).flatMap((stem) =>
    slot === 'top'
      ? [`${stem}_top`, stem]
      : slot === 'bottom'
        ? [`${stem}_bottom`, `${stem}_top`, stem]
        : [`${stem}_side`, stem],
  )
  // Old packs named a few things differently; `grass` is the common one.
  if (base === 'grass' || base === 'short_grass') candidates.push('grass', 'short_grass')
  for (const name of candidates) if (has(name)) return { name, tint }
  return null
}

/** Shared BlockTextures implementation over an assembled atlas. */
function makeTextures(tileSize: number, rgba: Uint8Array, layerKeys: string[]): BlockTextures {
  const texture = new THREE.DataArrayTexture(rgba, tileSize, tileSize, layerKeys.length)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  // three clamps this to the renderer's real max when it uploads the texture.
  texture.anisotropy = 16
  texture.needsUpdate = true

  const index = new Map(layerKeys.map((key, i) => [key, i]))
  const has = (name: string): boolean => index.has(name)

  // Per-block resolution is memoised: the mesher calls these per face per block.
  const resolved = new Map<string, { layers: number[]; tints: number[]; keys: number[] }>()
  const faceKeys = new Map<string, number>()
  const FACES: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz']

  const keyOf = (layer: number, tint: number): number => {
    const id = `${layer}:${tint}`
    let key = faceKeys.get(id)
    if (key === undefined) {
      key = faceKeys.size
      faceKeys.set(id, key)
    }
    return key
  }

  function entry(blockName: string) {
    let hit = resolved.get(blockName)
    if (hit) return hit
    const base = baseName(blockName)
    const fallbackTint = blockColour(blockName)
    hit = { layers: [], tints: [], keys: [] }
    for (const face of FACES) {
      const ref = resolveFace(base, SIDE_OF[face], has)
      const layer = ref ? (index.get(layerKeyOf(ref)) ?? WHITE_LAYER) : WHITE_LAYER
      const tint = ref ? ref.tint : fallbackTint
      const key = keyOf(layer, tint)
      hit.layers.push(layer)
      hit.tints.push(tint)
      hit.keys.push(key)
    }
    resolved.set(blockName, hit)
    return hit
  }

  const slot = (face: Face): number => FACES.indexOf(face)

  const refs = new Map<string, { layer: number; tint: number; key: number }>()

  return {
    texture,
    tileSize,
    layer: (blockName, face) => entry(blockName).layers[slot(face)],
    tint: (blockName, face) => entry(blockName).tints[slot(face)],
    faceKey: (blockName, face) => entry(blockName).keys[slot(face)],
    ref(textureName, blockName) {
      const id = `${textureName}|${blockName}`
      let hit = refs.get(id)
      if (hit) return hit
      const layer = index.get(textureName)
      hit =
        layer === undefined
          ? { layer: WHITE_LAYER, tint: blockColour(blockName), key: 0 }
          : { layer, tint: tintOfTexture(textureName), key: 0 }
      hit.key = keyOf(hit.layer, hit.tint)
      refs.set(id, hit)
      return hit
    },
  }
}

/**
 * Pack-free textures: a single white layer, tinted per block with the flat
 * colour from blocks.ts. Same interface as a real pack, so the mesher never
 * branches. (One white layer rather than one layer per colour — the tint
 * channel already does the work, and colours are generated on demand.)
 */
export function fallbackTextures(): BlockTextures {
  return makeTextures(1, new Uint8Array([255, 255, 255, 255]), ['__white__'])
}

// --- pack loading -----------------------------------------------------------

const TEXTURE_PATH = /(?:^|\/)assets\/minecraft\/textures\/blocks?\/(.+)\.png$/

function textureName(path: string): string | null {
  const match = TEXTURE_PATH.exec(path)
  return match ? match[1] : null
}

/** Inflate only the block PNGs, with entry and byte caps applied up front. */
function readBlockTextures(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  let budget = MAX_TEXTURE_BYTES
  let overflow = false
  const filter = (file: UnzipFileInfo): boolean => {
    if (!textureName(file.name)) return false
    // `size` is the uncompressed size from the zip's own header.
    if (file.size > MAX_PNG_BYTES) return false
    budget -= file.size
    if (budget < 0) {
      overflow = true
      return false
    }
    return true
  }
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter }, (error, files) => {
      if (error) {
        reject(new Error(`Could not read the pack archive: ${error.message}`))
        return
      }
      const out = new Map<string, Uint8Array>()
      for (const [path, data] of Object.entries(files)) {
        const name = textureName(path)
        if (name && out.size < MAX_LAYERS) out.set(name, data)
      }
      if (out.size === 0) {
        reject(
          new Error(
            overflow
              ? 'Pack rejected: its block textures exceed the size limit.'
              : 'No block textures found (expected assets/minecraft/textures/block/*.png).',
          ),
        )
        return
      }
      resolve(out)
    })
  })
}

/** Width/height straight out of the PNG IHDR, without decoding the image. */
function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return null
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

interface Decoded {
  width: number
  height: number
  data: Uint8ClampedArray
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  const element =
    typeof OffscreenCanvas !== 'undefined'
      ? (new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement)
      : Object.assign(document.createElement('canvas'), { width, height })
  const ctx = element.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No 2D canvas available to decode pack textures.')
  return ctx as CanvasRenderingContext2D
}

async function decodePng(png: Uint8Array): Promise<Decoded> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
  const { width, height } = bitmap
  const ctx = canvas2d(width, height)
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0)
  const data = ctx.getImageData(0, 0, width, height).data
  bitmap.close?.()
  return { width, height, data }
}

/**
 * One square tile of `size` px: first frame only (animated textures are a
 * vertical strip) and nearest-neighbour scaling — this is pixel art.
 */
function toTile(src: Decoded, size: number): Uint8Array {
  const frameHeight = src.height > src.width ? src.width : src.height
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const sy = Math.min(frameHeight - 1, Math.floor((y * frameHeight) / size))
    for (let x = 0; x < size; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / size))
      const s = (sy * src.width + sx) * 4
      const d = (y * size + x) * 4
      out[d] = src.data[s]
      out[d + 1] = src.data[s + 1]
      out[d + 2] = src.data[s + 2]
      out[d + 3] = src.data[s + 3]
    }
  }
  return out
}

/** Alpha-blend a tinted overlay tile onto a copy of the base tile. */
function composite(base: Uint8Array, overlay: Uint8Array, tint: number): Uint8Array {
  const out = base.slice()
  const tr = (tint >> 16) & 0xff
  const tg = (tint >> 8) & 0xff
  const tb = tint & 0xff
  for (let i = 0; i < out.length; i += 4) {
    const a = overlay[i + 3] / 255
    if (a === 0) continue
    out[i] = out[i] * (1 - a) + ((overlay[i] * tr) / 255) * a
    out[i + 1] = out[i + 1] * (1 - a) + ((overlay[i + 1] * tg) / 255) * a
    out[i + 2] = out[i + 2] * (1 - a) + ((overlay[i + 2] * tb) / 255) * a
    out[i + 3] = Math.max(out[i + 3], overlay[i + 3])
  }
  return out
}

/** Most common block texture width, rounded to a power of two and capped. */
function pickTileSize(pngs: Map<string, Uint8Array>): number {
  const votes = new Map<number, number>()
  for (const png of pngs.values()) {
    const size = pngSize(png)
    if (!size || size.width === 0) continue
    votes.set(size.width, (votes.get(size.width) ?? 0) + 1)
  }
  let best = 16
  let bestVotes = 0
  for (const [width, count] of votes) {
    if (count > bestVotes) {
      best = width
      bestVotes = count
    }
  }
  const pot = 2 ** Math.round(Math.log2(best))
  return Math.max(1, Math.min(MAX_TILE, pot))
}

interface Atlas {
  tileSize: number
  rgba: Uint8Array
  layerKeys: string[]
}

async function buildAtlas(
  pngs: Map<string, Uint8Array>,
  report: (message: string) => void,
): Promise<Atlas> {
  const tileSize = pickTileSize(pngs)
  const tileBytes = tileSize * tileSize * 4

  const composites = COMPOSITES.filter((c) => pngs.has(c.base) && pngs.has(c.overlay))
  const budget = Math.max(1, Math.floor(MAX_ATLAS_BYTES / tileBytes))
  const maxLayers = Math.min(MAX_LAYERS, budget)
  let names = [...pngs.keys()].sort()
  if (names.length + composites.length + 1 > maxLayers) {
    names = names.slice(0, maxLayers - composites.length - 1)
    report(
      `Pack is too large: using ${names.length} of ${pngs.size} textures; ` +
        'the rest fall back to flat colours.',
    )
  }

  const layerKeys = ['__white__', ...names, ...composites.map((c) => `${c.base}|${c.overlay}`)]
  const rgba = new Uint8Array(layerKeys.length * tileBytes)
  rgba.fill(0xff, 0, tileBytes) // layer 0: solid white

  const tiles = new Map<string, Uint8Array>()
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    let tile: Uint8Array
    try {
      tile = toTile(await decodePng(pngs.get(name)!), tileSize)
    } catch {
      continue // A corrupt PNG costs one texture, not the whole pack.
    }
    rgba.set(tile, (i + 1) * tileBytes)
    if (composites.some((c) => c.base === name || c.overlay === name)) tiles.set(name, tile)
    if (i % 128 === 0) {
      report(`Building texture atlas... ${i}/${names.length}`)
      await new Promise((done) => setTimeout(done, 0)) // let the tab paint
    }
  }

  composites.forEach((c, i) => {
    const base = tiles.get(c.base)
    const overlay = tiles.get(c.overlay)
    if (!base || !overlay) return
    rgba.set(composite(base, overlay, c.tint), (names.length + 1 + i) * tileBytes)
  })

  return { tileSize, rgba, layerKeys }
}

// --- IndexedDB cache (best effort; a failure here is never fatal) -----------

const DB_NAME = 'litematica-textures'
const STORE = 'atlas'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function cacheGet(key: string): Promise<Atlas | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      request.onsuccess = () => resolve((request.result as Atlas | undefined) ?? null)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function cachePut(key: string, atlas: Atlas): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(atlas, key)
  } catch {
    // Quota exceeded or private mode: carry on without caching.
  }
}

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return [...new Uint8Array(digest, 0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Parse a Minecraft client .jar or resource-pack .zip and build its atlas.
 * `onProgress` is optional; a pack takes seconds, so the caller should show it.
 */
export async function loadResourcePack(
  file: File | Blob,
  onProgress: (message: string) => void = () => {},
): Promise<BlockTextures> {
  if (file.size > MAX_PACK_BYTES) {
    throw new Error(`Pack is too large (over ${MAX_PACK_BYTES / (1024 * 1024)} MB).`)
  }
  onProgress('Reading pack...')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Not a .jar or .zip archive (missing PK header).')
  }

  const key = await hash(bytes).catch(() => '')
  if (key) {
    const cached = await cacheGet(key)
    if (cached) {
      onProgress(`Textures loaded from cache (${cached.layerKeys.length} layers).`)
      return makeTextures(cached.tileSize, new Uint8Array(cached.rgba), cached.layerKeys)
    }
  }

  onProgress('Extracting block textures...')
  const pngs = await readBlockTextures(bytes)
  const atlas = await buildAtlas(pngs, onProgress)
  if (key) await cachePut(key, atlas)
  onProgress(`Textures ready: ${atlas.layerKeys.length} layers at ${atlas.tileSize}px.`)
  return makeTextures(atlas.tileSize, atlas.rgba, atlas.layerKeys)
}
