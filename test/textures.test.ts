import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'
import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { blockColour } from '../src/blocks'
import { fallbackTextures, loadResourcePack, type BlockTextures } from '../src/textures'
import { encodePng, installPngDecodeStubs } from './png-testkit'

beforeAll(() => {
  installPngDecodeStubs()
})

// --- fixture helpers ---------------------------------------------------------

function solidPixels(size: number, rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) out.set(rgba, i * 4)
  return out
}

function solidPng(size: number, rgba: [number, number, number, number]): Uint8Array {
  return encodePng(size, size, solidPixels(size, rgba))
}

/** 32x32 four-quadrant checker: [[TL,TR],[BL,BR]]. */
function quadrantPng32(
  tl: [number, number, number, number],
  tr: [number, number, number, number],
  bl: [number, number, number, number],
  br: [number, number, number, number],
): Uint8Array {
  const size = 32
  const px = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = y < 16 ? (x < 16 ? tl : tr) : x < 16 ? bl : br
      px.set(c, (y * size + x) * 4)
    }
  }
  return encodePng(size, size, px)
}

/** 16-wide vertical animation strip, one 16x16 frame per colour. */
function stripPng(frames: [number, number, number, number][]): Uint8Array {
  const w = 16
  const h = 16 * frames.length
  const px = new Uint8Array(w * h * 4)
  for (let f = 0; f < frames.length; f++) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) px.set(frames[f], ((f * 16 + y) * w + x) * 4)
    }
  }
  return encodePng(w, h, px)
}

const blockPath = (name: string): string => `assets/minecraft/textures/block/${name}.png`

const FRAME0: [number, number, number, number] = [10, 20, 30, 255]
const FRAME1: [number, number, number, number] = [200, 100, 50, 255]
const RED: [number, number, number, number] = [255, 0, 0, 255]
const GREEN: [number, number, number, number] = [0, 255, 0, 255]

const mainPackFiles: Record<string, Uint8Array> = {
  [blockPath('stone')]: solidPng(16, [125, 125, 125, 255]),
  [blockPath('dirt')]: solidPng(16, [139, 95, 60, 255]),
  [blockPath('grass_block_top')]: solidPng(16, [90, 180, 60, 255]),
  [blockPath('grass_block_side')]: solidPng(16, [130, 110, 80, 255]),
  [blockPath('grass_block_side_overlay')]: solidPng(16, [255, 255, 255, 200]),
  [blockPath('oak_log')]: solidPng(16, [110, 90, 60, 255]),
  [blockPath('oak_log_top')]: solidPng(16, [180, 150, 100, 255]),
  [blockPath('oak_leaves')]: solidPng(16, [60, 140, 40, 255]),
  [blockPath('water_still')]: stripPng([FRAME0, FRAME1, [1, 1, 1, 255], [2, 2, 2, 255]]),
  [blockPath('sand')]: quadrantPng32(RED, GREEN, GREEN, RED),
}

function packFile(files: Record<string, Uint8Array>): Blob {
  const zipped = zipSync(files)
  return new Blob([zipped as BlobPart], { type: 'application/zip' })
}

function readLayer(textures: BlockTextures, layer: number): Uint8Array {
  const data = textures.texture.image.data as Uint8Array
  const bytes = textures.tileSize * textures.tileSize * 4
  return data.subarray(layer * bytes, layer * bytes + bytes)
}

describe('loadResourcePack', () => {
  let textures: BlockTextures

  beforeAll(async () => {
    textures = await loadResourcePack(packFile(mainPackFiles))
  })

  it('picks the majority tile size (16px)', () => {
    expect(textures.tileSize).toBe(16)
  })

  it('resolves all faces of a single-texture block to the same layer', () => {
    expect(textures.layer('minecraft:stone', 'px')).toBe(textures.layer('minecraft:stone', 'py'))
  })

  it('gives oak_log different layers for its top and side faces', () => {
    expect(textures.layer('minecraft:oak_log', 'py')).not.toBe(
      textures.layer('minecraft:oak_log', 'px'),
    )
  })

  it('tints grass_block top green and resolves its bottom to dirt', () => {
    expect(textures.tint('minecraft:grass_block', 'py')).not.toBe(0xffffff)
    expect(textures.layer('minecraft:grass_block', 'ny')).toBe(
      textures.layer('minecraft:dirt', 'py'),
    )
  })

  it('tints oak_leaves and leaves stone untinted', () => {
    expect(textures.tint('minecraft:oak_leaves', 'px')).not.toBe(0xffffff)
    expect(textures.tint('minecraft:stone', 'px')).toBe(0xffffff)
  })

  describe('faceKey', () => {
    it('is equal for two faces with the same layer and tint', () => {
      expect(textures.faceKey('minecraft:stone', 'px')).toBe(
        textures.faceKey('minecraft:stone', 'py'),
      )
    })

    it('differs when the layer differs', () => {
      expect(textures.faceKey('minecraft:oak_log', 'px')).not.toBe(
        textures.faceKey('minecraft:oak_log', 'py'),
      )
    })

    it('differs when the tint differs but the layer is the same', () => {
      // Both texture names are absent from the pack, so both fall back to the
      // shared white layer (0); only their block-colour tint differs.
      const a = textures.ref('__missing_a__', 'minecraft:stone')
      const b = textures.ref('__missing_b__', 'minecraft:grass_block')
      expect(a.layer).toBe(0)
      expect(b.layer).toBe(0)
      expect(a.tint).not.toBe(b.tint)
      expect(a.key).not.toBe(b.key)
    })
  })

  it('accepts the legacy assets/.../textures/blocks/<name>.png (plural) path', async () => {
    const legacy = await loadResourcePack(
      packFile({ 'assets/minecraft/textures/blocks/stone.png': solidPng(16, [1, 2, 3, 255]) }),
    )
    // A resolved stone face is untinted (0xffffff); an unresolved one falls
    // back to blockColour('stone'), which is not white. So this only passes
    // if the legacy path was actually matched.
    expect(legacy.tint('minecraft:stone', 'px')).toBe(0xffffff)
  })

  it('takes only the first frame of an animated strip', () => {
    const layer = textures.layer('minecraft:water', 'px')
    const pixel = readLayer(textures, layer).subarray(0, 4)
    expect([...pixel]).toEqual(FRAME0)
  })

  it('downscales a 32x32 texture to the pack tile size with nearest-neighbour crispness', () => {
    const layer = textures.layer('minecraft:sand', 'py')
    const tile = readLayer(textures, layer)
    const px = (x: number, y: number) => [...tile.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
    // Four corners of the 16x16 tile land deep inside the four source
    // quadrants (RED/GREEN/GREEN/RED), never on a blended boundary pixel.
    expect(px(0, 0)).toEqual(RED)
    expect(px(15, 0)).toEqual(GREEN)
    expect(px(0, 15)).toEqual(GREEN)
    expect(px(15, 15)).toEqual(RED)
  })

  it('gives an unresolved block a valid layer and a non-white blockColour tint', () => {
    const layer = textures.layer('minecraft:emerald_block', 'px')
    expect(layer).not.toBe(-1)
    expect(layer).toBeGreaterThanOrEqual(0)
    expect(textures.tint('minecraft:emerald_block', 'px')).toBe(blockColour('minecraft:emerald_block'))
  })

  it('sets repeat wrapping, nearest filtering and sRGB colour space', () => {
    expect(textures.texture.wrapS).toBe(THREE.RepeatWrapping)
    expect(textures.texture.wrapT).toBe(THREE.RepeatWrapping)
    expect(textures.texture.magFilter).toBe(THREE.NearestFilter)
    expect(textures.texture.colorSpace).toBe(THREE.SRGBColorSpace)
  })

  it('loads successfully even though Node has no indexedDB', () => {
    expect(typeof indexedDB).toBe('undefined')
    // The beforeAll load above already exercised this path without throwing;
    // this test documents why that is a meaningful assertion.
    expect(textures.tileSize).toBeGreaterThan(0)
  })

  it('rejects a non-zip file', async () => {
    const notAZip = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])])
    await expect(loadResourcePack(notAZip)).rejects.toThrow(/zip|archive|PK/i)
  })

  it('rejects a zip with no block textures', async () => {
    const empty = packFile({ 'readme.txt': new TextEncoder().encode('hello') })
    await expect(loadResourcePack(empty)).rejects.toThrow(/block texture/i)
  })
})

describe('fallbackTextures', () => {
  const textures = fallbackTextures()

  it('always resolves to the same single layer', () => {
    expect(textures.layer('minecraft:stone', 'px')).toBe(textures.layer('minecraft:dirt', 'py'))
  })

  it('tints with blockColour', () => {
    expect(textures.tint('minecraft:stone', 'px')).toBe(blockColour('minecraft:stone'))
  })

  it('sets repeat wrapping, nearest filtering and sRGB colour space', () => {
    expect(textures.texture.wrapS).toBe(THREE.RepeatWrapping)
    expect(textures.texture.wrapT).toBe(THREE.RepeatWrapping)
    expect(textures.texture.magFilter).toBe(THREE.NearestFilter)
    expect(textures.texture.colorSpace).toBe(THREE.SRGBColorSpace)
  })
})

// --- public/default-pack.zip -------------------------------------------------

const defaultPackPath = fileURLToPath(new URL('../public/default-pack.zip', import.meta.url))
const defaultPackBytes = readFileSync(defaultPackPath)

function ihdrSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

describe('public/default-pack.zip', () => {
  const files = unzipSync(new Uint8Array(defaultPackBytes))
  const names = Object.keys(files)

  it('opens as a zip and contains pack.mcmeta', () => {
    expect(names).toContain('pack.mcmeta')
  })

  it('has no entries besides pack.mcmeta and block textures/animation metadata', () => {
    const allowed = /^assets\/minecraft\/textures\/block\/[a-z0-9_]+\.png(\.mcmeta)?$/
    const stray = names.filter((n) => n !== 'pack.mcmeta' && !allowed.test(n))
    expect(stray).toEqual([])
  })

  it('sizes every PNG at least 16px wide, a power of two, with stone.png exactly 16x16', () => {
    for (const [name, data] of Object.entries(files)) {
      if (!name.endsWith('.png')) continue
      const { width } = ihdrSize(data)
      expect(width, `${name} width`).toBeGreaterThanOrEqual(16)
      expect((width & (width - 1)) === 0, `${name} width ${width} not a power of two`).toBe(true)
    }
    expect(ihdrSize(files['assets/minecraft/textures/block/stone.png'])).toEqual({
      width: 16,
      height: 16,
    })
  })

  it('has every texture the app relies on for Hill', () => {
    const required = [
      'stone',
      'dirt',
      'grass_block_top',
      'grass_block_side',
      'grass_block_side_overlay',
      'spruce_log',
      'spruce_log_top',
      'spruce_leaves',
      'fern',
      'short_grass',
      'spruce_trapdoor',
      'stone_bricks',
      'cobblestone',
      'water_still',
      'furnace_front',
    ]
    for (const name of required) {
      expect(names, name).toContain(`assets/minecraft/textures/block/${name}.png`)
    }
    expect(names).toContain('assets/minecraft/textures/block/water_still.png.mcmeta')
  })

  it('decodes through loadResourcePack and gives cutout textures transparent texels', async () => {
    const textures = await loadResourcePack(
      new Blob([defaultPackBytes as unknown as BlobPart], { type: 'application/zip' }),
    )
    for (const name of ['fern', 'short_grass', 'spruce_leaves', 'poppy']) {
      const layer = textures.ref(name, 'minecraft:air').layer
      expect(layer, name).not.toBe(0) // must have actually resolved to the real texture
      const tile = readLayer(textures, layer)
      let sawTransparent = false
      for (let i = 3; i < tile.length; i += 4) {
        if (tile[i] === 0) {
          sawTransparent = true
          break
        }
      }
      expect(sawTransparent, `${name} has no fully-transparent texel`).toBe(true)
    }
  })

  it('is within a sane size bound for real vanilla block textures', () => {
    expect(defaultPackBytes.length).toBeGreaterThan(200 * 1024)
    expect(defaultPackBytes.length).toBeLessThan(10 * 1024 * 1024)
  })
})
