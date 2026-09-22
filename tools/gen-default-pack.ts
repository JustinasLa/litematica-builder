/**
 * Generates `public/default-pack.zip` — the bundled, texture-pack-shaped set of
 * block textures the app ships so it looks textured with no user action.
 *
 * Every pixel here is computed from the code below. Nothing is copied, traced
 * or derived from Mojang assets. Output is CC0 (see tools/README.md).
 *
 *   node tools/gen-default-pack.ts                # write the zip
 *   node tools/gen-default-pack.ts --sheet <png>  # also write a contact sheet
 *
 * Deterministic by construction: a fixed-seed integer hash (never Math.random),
 * fflate's pure-JS deflate, and a fixed mtime on every zip entry. Running it
 * twice produces a byte-identical zip.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, zlibSync } from 'fflate'

type Rgb = [number, number, number]
/** One pixel: r, g, b, a, each 0-255. */
type Px = [number, number, number, number]
/** One 16x16 RGBA image, row-major. */
type Tile = Uint8Array
/** Every texture is a pure function from pixel coordinate to colour. */
type PixelFn = (x: number, y: number) => Px
/** Which axes a texture has to repeat along; see assertTiles. */
type Axes = 'both' | 'x' | 'frame'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const S = 16 // vanilla's art scale
const PACK_FORMAT = 34 // 1.21.x

// --- deterministic noise ----------------------------------------------------

/** 2D integer hash -> [0,1). Fixed output for fixed input, no global state. */
function hash(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2545f491)
  h ^= h >>> 13
  h = Math.imul(h, 0x27d4eb2d)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const smooth = (t: number): number => t * t * (3 - 2 * t)
const wrap = (a: number, n: number): number => ((a % n) + n) % n

/** Per-pixel grit. Coordinates are wrapped so the field is exactly 16-periodic
 *  — the whole tileability guarantee rests on every generator being periodic. */
const pn = (x: number, y: number, seed: number): number => hash(wrap(x, S), wrap(y, S), seed)

/**
 * Value noise on a lattice of `cx` by `cy` cells across the tile. Lattice
 * indices are taken modulo the cell count, so the field wraps exactly at the
 * tile edge — this is what makes every texture tileable.
 * `cx`/`cy` must divide S.
 */
function noise(x: number, y: number, cx: number, cy: number, seed: number): number {
  const gx = (x * cx) / S
  const gy = (y * cy) / S
  const i = Math.floor(gx)
  const j = Math.floor(gy)
  const fx = smooth(gx - i)
  const fy = smooth(gy - j)
  const at = (u: number, v: number): number => hash(wrap(u, cx), wrap(v, cy), seed)
  const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx
  const bot = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx
  return top * (1 - fy) + bot * fy
}

/** Two octaves plus per-pixel grit, centred on 0. */
function fbm(x: number, y: number, seed: number): number {
  return (
    (noise(x, y, 4, 4, seed) - 0.5) * 1.0 +
    (noise(x, y, 8, 8, seed + 101) - 0.5) * 0.6 +
    (pn(x, y, seed + 202) - 0.5) * 0.55
  )
}

/** Toroidal delta, so distances measured across the tile edge wrap. */
const tor = (d: number): number => d - S * Math.round(d / S)

/** Wrapping jittered-grid cellular noise: `cells` feature points per axis. */
function cellular(
  x: number,
  y: number,
  cells: number,
  seed: number,
  jitter: number,
): { f1: number; edge: number; id: number } {
  const size = S / cells
  let f1 = 1e9
  let f2 = 1e9
  let id = 0
  const ci = Math.floor(x / size)
  const cj = Math.floor(y / size)
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const mi = wrap(ci + di, cells)
      const mj = wrap(cj + dj, cells)
      const px = (ci + di + 0.5 + (hash(mi, mj, seed) - 0.5) * jitter) * size
      const py = (cj + dj + 0.5 + (hash(mi, mj, seed ^ 0x9e3779b9) - 0.5) * jitter) * size
      const d = Math.hypot(px - x, py - y)
      if (d < f1) {
        f2 = f1
        f1 = d
        id = mi * 37 + mj * 7919
      } else if (d < f2) {
        f2 = d
      }
    }
  }
  return { f1, edge: f2 - f1, id }
}

// --- pixel plumbing ---------------------------------------------------------

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
const rgb = (hex: number): Rgb => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** Drop the alpha channel, so a sampled pixel can be re-shaded. */
const opaque = (p: Px): Rgb => [p[0], p[1], p[2]]

/** base colour + a signed lightness delta. */
function shade(base: Rgb, d: number, a = 255): Px {
  return [clamp(base[0] + d), clamp(base[1] + d), clamp(base[2] + d), a]
}

/** Flat grey with a lightness delta — for textures the app tints at runtime. */
const grey = (lum: number, a = 255): Px => [clamp(lum), clamp(lum), clamp(lum), a]

function draw(fn: PixelFn): Tile {
  const out = new Uint8Array(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = fn(x, y)
      const i = (y * S + x) * 4
      out[i] = clamp(p[0])
      out[i + 1] = clamp(p[1])
      out[i + 2] = clamp(p[2])
      out[i + 3] = clamp(p[3])
    }
  }
  return out
}

// --- texture generators -----------------------------------------------------

/** Mottled rock: two noise octaves, per-pixel grit, optional darker blotches. */
function rock(hex: number, seed: number, amp = 30, blotch = 0): PixelFn {
  const base = rgb(hex)
  return (x, y) => {
    let d = fbm(x, y, seed) * amp
    if (blotch !== 0) {
      const b = noise(x, y, 4, 4, seed + 303)
      if (b > 0.62) d += blotch * (b - 0.62) * 3
    }
    return shade(base, d)
  }
}

/** Grainy soil: heavy per-pixel grit plus scattered dark crumbs. */
function soil(hex: number, seed: number, amp = 26, crumb = -34): PixelFn {
  const base = rgb(hex)
  return (x, y) => {
    let d = (pn(x, y, seed) - 0.5) * amp + (noise(x, y, 8, 8, seed + 11) - 0.5) * amp * 0.9
    const c = pn(x, y, seed + 77)
    if (c > 0.88) d += crumb * (c - 0.88) * 8
    else if (c < 0.06) d += 16
    return shade(base, d)
  }
}

/** Irregular stones with recessed mortar between them. */
function cobble(hex: number, seed: number, cells = 3, mortarDelta = -52): PixelFn {
  const base = rgb(hex)
  return (x, y) => {
    const c = cellular(x, y, cells, seed, 0.9)
    // edge = distance between the two nearest stone centres; ~1 means we are
    // within half a pixel of the boundary, which is where the mortar goes.
    if (c.edge < 1.0) return shade(base, mortarDelta + (pn(x, y, seed + 31) - 0.5) * 14)
    const tone = (hash(c.id, 3, seed + 5) - 0.5) * 42
    const dome = Math.max(0, 1 - c.f1 / 2.6) * 18 // lit toward each stone's centre
    const grit = (pn(x, y, seed + 9) - 0.5) * 14 + (noise(x, y, 8, 8, seed + 13) - 0.5) * 12
    return shade(base, tone + dome + grit)
  }
}

/** Offset brick courses with mortar lines and per-brick tone. */
function bricks(hex: number, seed: number, bw: number, bh: number, mortarHex: number): PixelFn {
  const base = rgb(hex)
  const m = rgb(mortarHex)
  return (x, y) => {
    const row = wrap(Math.floor(y / bh), S / bh) // wrapped: the tile must be y-periodic
    const off = (row % 2) * (bw / 2)
    const bx = Math.floor(wrap(x + off, S) / bw)
    const onMortar = y % bh === 0 || wrap(x + off, S) % bw === 0
    if (onMortar) return shade(m, (pn(x, y, seed + 31) - 0.5) * 12)
    const tone = (hash(bx, row, seed + 3) - 0.5) * 26
    const grit = (pn(x, y, seed + 7) - 0.5) * 18 + (noise(x, y, 8, 8, seed + 17) - 0.5) * 16
    // Bevel: brighter along the top edge of each brick, darker along the bottom.
    const bevel = y % bh === 1 ? 10 : y % bh === bh - 1 ? -9 : 0
    return shade(base, tone + grit + bevel)
  }
}

/** Horizontal planks: seam rows, staggered end joints, grain along x. */
function planks(hex: number, seed: number): PixelFn {
  const base = rgb(hex)
  return (x, y) => {
    const row = wrap(Math.floor(y / 4), 4) // wrapped: the tile must be y-periodic
    const tone = (hash(row, 0, seed + 2) - 0.5) * 20
    // Grain: varies fast across the plank (y), slowly along it (x).
    const grain =
      (noise(x, y, 2, 16, seed + 5) - 0.5) * 44 + (noise(x, y, 4, 8, seed + 6) - 0.5) * 20 +
      (pn(x, y, seed + 8) - 0.5) * 12
    if (y % 4 === 0) return shade(base, -26 + (pn(x, y, seed + 9) - 0.5) * 14)
    const joint = wrap(row * 5 + 3, S)
    if (wrap(x, S) === joint) return shade(base, -20 + (pn(x, y, seed + 10) - 0.5) * 10)
    const bevel = y % 4 === 1 ? 8 : y % 4 === 3 ? -8 : 0
    return shade(base, tone + grain + bevel)
  }
}

/** Bark: vertical striations with a few deeper grooves. */
function logSide(hex: number, seed: number, amp = 34): PixelFn {
  const base = rgb(hex)
  return (x, y) => {
    // Varies fast across the trunk (x), slowly up it (y).
    const stria =
      (noise(x, y, 16, 2, seed) - 0.5) * amp + (noise(x, y, 8, 4, seed + 4) - 0.5) * amp * 0.5
    const grit = (pn(x, y, seed + 6) - 0.5) * 14
    const groove = pn(x, 0, seed + 12) > 0.82 ? -18 : 0
    return shade(base, stria + grit + groove)
  }
}

/** Growth rings inside a 1px bark border (the border is what makes it tile). */
function logTop(hex: number, barkHex: number, seed: number): PixelFn {
  const base = rgb(hex)
  const bark = rgb(barkHex)
  return (x, y) => {
    if (x === 0 || y === 0 || x === S - 1 || y === S - 1) {
      return shade(bark, (pn(x, y, seed + 21) - 0.5) * 22)
    }
    const dx = x - 7.5
    const dy = y - 7.5
    const r = Math.hypot(dx, dy) + (noise(x, y, 4, 4, seed + 2) - 0.5) * 1.6
    const ring = Math.abs(((r * 0.78) % 1) - 0.5) * 2 // 0 mid-ring, 1 on a ring line
    const grit = (pn(x, y, seed + 3) - 0.5) * 12
    const core = r < 1.6 ? -14 : 0
    return shade(base, (0.5 - ring) * 34 + grit + core)
  }
}

/**
 * Leaf clusters in luminance only — the app multiplies the foliage biome tint
 * over these, so any baked green would come out doubled. Holes are fully
 * transparent because the mesher alpha-tests at 0.5.
 */
function leaves(lum: number, seed: number, holeAt = 2.55): PixelFn {
  return (x, y) => {
    const clump = cellular(x, y, 4, seed, 1.0)
    // Holes open up where a pixel is far from every cluster centre. The
    // threshold is itself smooth noise, so gaps are blobby, not dithered.
    const cut = holeAt + (noise(x, y, 8, 8, seed + 17) - 0.5) * 0.45
    if (clump.f1 > cut) return grey(0, 0)
    // Keep the per-pixel grit modest: at 16px, heavy value noise on a grey
    // tile reads as television static rather than foliage.
    const dome = (1 - Math.min(1, clump.f1 / 2.6)) * 50 // lit centre of each clump
    const rim = clump.f1 > cut - 0.6 ? -26 : 0 // dark outline around each clump
    const grit = (pn(x, y, seed + 5) - 0.5) * 12 + (noise(x, y, 8, 8, seed + 9) - 0.5) * 12
    return grey(lum - 26 + dome + rim + grit)
  }
}

/** Ore blobs of `oreHex` embedded in a stone matrix, wrapped toroidally. */
function ore(stoneHex: number, oreHex: number, seed: number): PixelFn {
  const stone = rock(stoneHex, 4001)
  const oreRgb = rgb(oreHex)
  const blobs = Array.from({ length: 4 }, (_, i) => ({
    cx: hash(i, 1, seed) * S,
    cy: hash(i, 2, seed) * S,
    r: 1.5 + hash(i, 3, seed) * 1.1,
  }))
  return (x, y) => {
    for (const b of blobs) {
      const d =
        Math.hypot(tor(x + 0.5 - b.cx), tor(y + 0.5 - b.cy)) + (pn(x, y, seed + 40) - 0.5) * 0.8
      if (d < b.r) {
        const lift = (1 - d / b.r) * 26 - 8
        return shade(oreRgb, lift + (pn(x, y, seed + 41) - 0.5) * 18)
      }
      if (d < b.r + 0.85) return shade(rgb(stoneHex), -26) // recessed outline
    }
    return stone(x, y)
  }
}

/** Woven cloth: a 2px weave plus fibre noise. */
function wool(hex: number, seed: number): PixelFn {
  const base = rgb(hex)
  return (x, y) => {
    const weave = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0 ? 7 : -7
    const fibre = (pn(x, y, seed) - 0.5) * 20 + (noise(x, y, 8, 8, seed + 3) - 0.5) * 14
    const knot = pn(x, y, seed + 6) > 0.93 ? -14 : 0
    return shade(base, weave + fibre + knot)
  }
}

/** A dirt block with a differently-coloured cap on its top rows. */
function cappedSide(dirtHex: number, capHex: number, capRows: number, seed: number): PixelFn {
  const dirt = soil(dirtHex, seed)
  const cap = rgb(capHex)
  return (x, y) => {
    const depth = capRows + Math.floor(pn(x, 0, seed + 55) * 2)
    if (y < depth) return shade(cap, (pn(x, y, seed + 56) - 0.5) * 26)
    return dirt(x, y)
  }
}

/**
 * A hand-placed sprite: paint into a buffer, then serve it as a pixel
 * function. Coordinates wrap on read and write, so the result is 16-periodic
 * and passes the same tiling check as everything else.
 */
function sprite(paint: (put: (x: number, y: number, p: Px) => void) => void): PixelFn {
  const buf = new Uint8Array(S * S * 4) // starts fully transparent
  const put = (x: number, y: number, p: Px): void => {
    const i = (wrap(y, S) * S + wrap(x, S)) * 4
    buf[i] = clamp(p[0])
    buf[i + 1] = clamp(p[1])
    buf[i + 2] = clamp(p[2])
    buf[i + 3] = clamp(p[3])
  }
  paint(put)
  return (x, y) => {
    const i = (wrap(y, S) * S + wrap(x, S)) * 4
    return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
  }
}

/**
 * A clump of blades rooted on the bottom edge, on transparent background.
 * `hex` null means greyscale: the grass family is biome-tinted at render time.
 */
function tuft(
  lum: number,
  seed: number,
  count: number,
  hMin: number,
  hMax: number,
  hex: number | null = null,
): PixelFn {
  const base = hex === null ? null : rgb(hex)
  return sprite((put) => {
    for (let i = 0; i < count; i++) {
      const bx = 1 + Math.floor(hash(i, 0, seed) * (S - 2))
      const h = hMin + Math.floor(hash(i, 1, seed) * (hMax - hMin + 1))
      const lean = hash(i, 2, seed) < 0.5 ? -1 : 1
      const tone = (hash(i, 3, seed) - 0.5) * 36
      for (let k = 0; k < h; k++) {
        const t = k / Math.max(1, h - 1)
        const x = bx + Math.round(t * t * 2.4) * lean
        const y = S - 1 - k
        const d = tone + t * 28 - 12 + (pn(x, y, seed + 9) - 0.5) * 16
        put(x, y, base ? shade(base, d) : grey(lum + d))
        // Thicken the lower half so a blade still reads at 16px.
        if (t < 0.5) put(x + lean, y, base ? shade(base, d - 16) : grey(lum + d - 16))
      }
    }
  })
}

/** Stem, two leaves and a round head. */
function flower(
  petalHex: number,
  coreHex: number,
  seed: number,
  headTop: number,
  headBottom: number,
  radius = 3.2,
): PixelFn {
  const petal = rgb(petalHex)
  const core = rgb(coreHex)
  const stem = rgb(0x4b7a28)
  const cy = (headTop + headBottom) / 2
  return sprite((put) => {
    for (let y = S - 1; y > headBottom - 1; y--) {
      const x = y < 11 ? 8 : 7
      put(x, y, shade(stem, (pn(x, y, seed) - 0.5) * 26))
    }
    for (const [lx, ly] of [
      [5, 12],
      [6, 12],
      [9, 10],
      [10, 10],
    ]) {
      put(lx, ly, shade(stem, -12 + (pn(lx, ly, seed + 1) - 0.5) * 20))
    }
    for (let y = headTop; y <= headBottom; y++) {
      for (let x = 3; x <= 12; x++) {
        const d = Math.hypot(x - 7.5, y - cy)
        if (d > radius) continue
        const isCore = d < radius * 0.35
        put(x, y, shade(isCore ? core : petal, (pn(x, y, seed + 3) - 0.5) * 34 + (x < 7 ? 8 : -8)))
      }
    }
  })
}

/** Capped stalk; `spots` sprinkles the pale flecks of a red mushroom. */
function mushroom(capHex: number, stemHex: number, seed: number, spots: boolean): PixelFn {
  const cap = rgb(capHex)
  const stem = rgb(stemHex)
  return sprite((put) => {
    for (let y = 11; y <= 14; y++) {
      for (let x = 7; x <= 8; x++) put(x, y, shade(stem, (pn(x, y, seed) - 0.5) * 22))
    }
    for (let x = 5; x <= 10; x++) put(x, 10, shade(stem, -20)) // gills
    for (let y = 5; y <= 9; y++) {
      const half = y === 5 ? 2 : y === 6 ? 3 : 4
      for (let x = 7 - half; x <= 8 + half; x++) {
        if (spots && pn(x, y, seed + 5) > 0.8) {
          put(x, y, [236, 234, 226, 255])
          continue
        }
        put(x, y, shade(cap, (x < 7 ? 10 : -10) + (pn(x, y, seed + 2) - 0.5) * 26))
      }
    }
  })
}

/** Three boards with a transparent slot between them, plus a darker frame. */
function trapdoor(hex: number, seed: number): PixelFn {
  const board = planks(hex, seed)
  return (x, y) => {
    if ((y === 5 || y === 10) && x > 1 && x < S - 2) return grey(0, 0)
    const p = board(x, y)
    const frame = x === 0 || x === S - 1 || y === 0 || y === S - 1
    return frame ? shade(opaque(p), -26) : p
  }
}

/** A block face that reads as a box: base texture inside a darker 1px frame. */
function panel(base: PixelFn, frameDelta = -30): PixelFn {
  return (x, y) => {
    const p = base(x, y)
    if (x === 0 || y === 0 || x === S - 1 || y === S - 1) {
      return shade(opaque(p), frameDelta)
    }
    return p
  }
}

const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1

// --- the pack ---------------------------------------------------------------

const DYES: Record<string, number> = {
  white: 0xe9ecec,
  orange: 0xf07613,
  magenta: 0xbd44b3,
  light_blue: 0x3aafd9,
  yellow: 0xf8c627,
  lime: 0x70b919,
  pink: 0xed8dac,
  gray: 0x3e4447,
  light_gray: 0x8e8e86,
  cyan: 0x158991,
  purple: 0x792ab3,
  blue: 0x35399d,
  brown: 0x724728,
  green: 0x546d1b,
  red: 0xa12722,
  black: 0x141519,
}

// axes 'x': only horizontal tiling is required — the texture is deliberately
// banded top-to-bottom, exactly as its vanilla equivalent is.
const pack: { name: string; fn: PixelFn; tile: Tile; axes: Axes }[] = []
const add = (name: string, fn: PixelFn, axes: Axes = 'both'): void => {
  pack.push({ name, fn, tile: draw(fn), axes })
}
/** Same art under a second vanilla name (hyphae reuse their stem textures). */
const alias = (name: string, from: string): void => {
  const src = pack.find((t) => t.name === from)
  if (!src) throw new Error(`alias ${name}: no such texture ${from}`)
  pack.push({ name, fn: src.fn, tile: src.tile, axes: src.axes })
}

// stone family
add('stone', rock(0x7d7d7d, 1001, 30))
add('smooth_stone', rock(0x9d9d9d, 1002, 16))
add('andesite', rock(0x8a8a8c, 1003, 26, -20))
add('diorite', rock(0xbfbfbd, 1004, 40, -34))
add('granite', rock(0x9a6a55, 1005, 34, -30))
add('tuff', rock(0x6c6e65, 1006, 30, -22))
add('calcite', rock(0xdfdedb, 1007, 18))
add('deepslate', logSide(0x515156, 1008, 24))
add('cobbled_deepslate', cobble(0x50505a, 1009, 4, -30))
add('bedrock', cobble(0x565656, 1010, 5, -46))
add('obsidian', rock(0x160e26, 1011, 22, 18))
add('netherrack', soil(0x6f3634, 1012, 30, -30))
add('cobblestone', cobble(0x7f7f7f, 1101))
add('mossy_cobblestone', cobble(0x6f7d60, 1102))
add('stone_bricks', bricks(0x7d7d7d, 1201, 8, 4, 0x5a5a5a))
add('cracked_stone_bricks', bricks(0x767672, 1202, 8, 4, 0x555553))
add('polished_blackstone_bricks', bricks(0x322c36, 1203, 8, 4, 0x221d25))
add('bricks', bricks(0x9a5b47, 1204, 8, 4, 0xa8a49f))
add('smooth_quartz', rock(0xe7e2da, 1205, 12))
add('clay', rock(0xa0a7b4, 1206, 18))
add('terracotta', rock(0x985e43, 1207, 22, -16))

// soil and ground
add('dirt', soil(0x8b5f3c, 2001))
add('coarse_dirt', soil(0x7f5836, 2002, 32, -44))
add('rooted_dirt', soil(0x906d52, 2003, 26, -30))
add('gravel', (x, y) => {
  const c = cellular(x, y, 5, 2101, 1.0)
  const base = rgb(0x8a8482)
  if (c.edge < 0.8) return shade(base, -34 + (pn(x, y, 2104) - 0.5) * 16)
  const tone = (hash(c.id, 11, 2102) - 0.5) * 58
  const dome = Math.max(0, 1 - c.f1 / 2.0) * 14
  const grit = (pn(x, y, 2103) - 0.5) * 20
  return shade(base, tone + dome + grit)
})
add('sand', soil(0xdbd3a0, 2201, 20, -22))
add('red_sand', soil(0xbe6721, 2202, 20, -22))
add('sandstone_top', soil(0xdcd4a6, 2203, 16, -18))
add('sandstone_bottom', soil(0xd6cd9c, 2204, 16, -18))
add(
  'sandstone',
  (x, y) => {
    // Sedimentary banding: horizontal layers with a lip under the top course.
    const base = rgb(0xdcd3a2)
    const band = (noise(x, y, 2, 16, 2205) - 0.5) * 16
    const layer = y < 4 ? 8 : y === 4 ? -22 : (Math.floor(y / 4) % 2) * -6
    const grit = (pn(x, y, 2206) - 0.5) * 16
    return shade(base, band + layer + grit)
  },
  'x',
)
add('smooth_sandstone', soil(0xd9d0a0, 2207, 12, -12))
add('snow', rock(0xf1f7f8, 2301, 12))
add('snow_block', rock(0xf1f7f8, 2301, 12))
add('soul_sand', (x, y) => {
  const base = rgb(0x574438)
  const pit = cellular(x, y, 3, 2401, 0.9)
  const d = pit.f1 < 1.5 ? -30 * (1 - pit.f1 / 1.5) : 0
  return shade(base, d + (pn(x, y, 2402) - 0.5) * 24)
})
add('farmland', (x, y) => {
  const base = rgb(0x6b4726)
  const furrow = y % 4 === 0 ? -20 : y % 4 === 1 ? 8 : 0
  return shade(base, furrow + (pn(x, y, 2501) - 0.5) * 22 + (noise(x, y, 8, 8, 2502) - 0.5) * 18)
})
add('dirt_path_top', soil(0x9b8350, 2601, 22, -26))
add('dirt_path_side', cappedSide(0x8b5f3c, 0x9b8350, 1, 2602), 'x')
add('podzol_top', soil(0x5c3f19, 2701, 30, -30))
add('podzol_side', cappedSide(0x8b5f3c, 0x5c3f19, 3, 2702), 'x')
add('moss_block', (x, y) => {
  const base = rgb(0x5a6e21)
  const clump = cellular(x, y, 4, 2801, 1.0)
  const lobe = (0.9 - Math.min(1, clump.f1 / 2.4)) * 22
  return shade(base, lobe + (pn(x, y, 2802) - 0.5) * 34 + (noise(x, y, 8, 8, 2803) - 0.5) * 24)
})
add('warped_wart_block', (x, y) => {
  const base = rgb(0x1a6f68)
  const pit = cellular(x, y, 4, 2901, 1.0)
  return shade(base, (pit.edge < 0.4 ? -26 : 8) + (pn(x, y, 2902) - 0.5) * 30)
})
add('oxidized_copper', rock(0x53a486, 2911, 26, -30))

// grass block: authored in luminance, tinted by the app at render time
add('grass_block_top', (x, y) => {
  // Luminance only: the app multiplies the grass biome tint over this.
  const blade = (noise(x, y, 16, 16, 3001) - 0.5) * 34
  const clump = (noise(x, y, 4, 4, 3002) - 0.5) * 26
  return grey(202 + blade + clump + (pn(x, y, 3003) - 0.5) * 18)
})
add('grass_block_side', soil(0x8b5f3c, 2001)) // plain dirt; the overlay adds grass
add(
  'grass_block_side_overlay',
  (x, y) => {
    const depth = 3 + Math.floor(pn(x, 0, 3101) * 3) // ragged 3..5px fringe
    if (y >= depth) return grey(0, 0)
    return grey(224 + (pn(x, y, 3102) - 0.5) * 30 + (noise(x, y, 8, 8, 3103) - 0.5) * 20)
  },
  'x',
)

// leaves: luminance only (the foliage tint is applied at render time)
add('oak_leaves', leaves(186, 4001))
add('spruce_leaves', leaves(132, 4002, 2.8))
add('birch_leaves', leaves(204, 4003))
add('jungle_leaves', leaves(182, 4004, 2.7))
add('dark_oak_leaves', leaves(156, 4005, 2.75))
add('acacia_leaves', leaves(190, 4006))
add('mangrove_leaves', leaves(172, 4007))
// azalea is not tinted by the app, so it carries its own green
add('azalea_leaves', (x, y) => {
  const base = rgb(0x5d8f36)
  const clump = cellular(x, y, 4, 4101, 1.0)
  if (clump.f1 > 2.5 + (noise(x, y, 8, 8, 4102) - 0.5) * 0.5) return grey(0, 0)
  const tip = pn(x, y, 4104) > 0.9 ? 26 : 0
  return shade(base, (0.9 - Math.min(1, clump.f1 / 2.4)) * 26 + tip + (pn(x, y, 4105) - 0.5) * 34)
})

// logs and planks
const WOODS: [string, number, number, number][] = [
  // name, bark, heartwood, seed
  ['oak', 0x6f5934, 0xb0904f, 5001],
  ['spruce', 0x3f2a16, 0x7a5a33, 5002],
  ['birch', 0xd6d0c4, 0xc8b177, 5003],
  ['jungle', 0x564020, 0xa5794f, 5004],
  ['acacia', 0x6a6259, 0xa2622f, 5005],
  ['dark_oak', 0x3b2b19, 0x4c3418, 5006],
  ['mangrove', 0x5a3227, 0x77372a, 5007],
]
for (const [name, bark, heart, seed] of WOODS) {
  add(`${name}_log`, logSide(bark, seed))
  add(`${name}_log_top`, logTop(heart, bark, seed), 'frame')
}
add('stripped_spruce_log', logSide(0x7a5a33, 5102, 22))
add('stripped_spruce_log_top', logTop(0x7a5a33, 0x6a4d2c, 5102), 'frame')
add('stripped_oak_log', logSide(0xb0904f, 5101, 22))
add('stripped_oak_log_top', logTop(0xb0904f, 0x9c7f45, 5101), 'frame')

const PLANKS: [string, number, number][] = [
  ['oak_planks', 0xa4834d, 6001],
  ['spruce_planks', 0x6f5334, 6002],
  ['birch_planks', 0xc6b177, 6003],
  ['jungle_planks', 0xa07550, 6004],
  ['acacia_planks', 0xa85b25, 6005],
  ['dark_oak_planks', 0x4b3319, 6006],
  ['warped_planks', 0x2b6a68, 6007],
  ['crimson_planks', 0x6a344b, 6008],
]
for (const [name, hex, seed] of PLANKS) add(name, planks(hex, seed))

// ores
const ORES: [string, number, number, number][] = [
  ['coal_ore', 0x7d7d7d, 0x2f2f2f, 7001],
  ['iron_ore', 0x7d7d7d, 0xd9af95, 7002],
  ['copper_ore', 0x7d7d7d, 0xdd8b58, 7003],
  ['gold_ore', 0x7d7d7d, 0xf2cd5c, 7004],
  ['redstone_ore', 0x7d7d7d, 0xd42e26, 7005],
  ['lapis_ore', 0x7d7d7d, 0x2f57b8, 7006],
  ['diamond_ore', 0x7d7d7d, 0x53dbd4, 7007],
  ['emerald_ore', 0x7d7d7d, 0x2ecb56, 7008],
  ['deepslate_coal_ore', 0x515156, 0x2f2f2f, 7011],
  ['deepslate_iron_ore', 0x515156, 0xd9af95, 7012],
  ['deepslate_diamond_ore', 0x515156, 0x53dbd4, 7013],
  ['deepslate_gold_ore', 0x515156, 0xf2cd5c, 7014],
]
for (const [name, stone, vein, seed] of ORES) add(name, ore(stone, vein, seed))

// wool
let woolSeed = 8000
for (const [dye, hex] of Object.entries(DYES)) add(`${dye}_wool`, wool(hex, woolSeed++))

// water: luminance only, the app multiplies the water tint over it
add('water_still', (x, y) => {
  // Ripples: a smooth swell crossed by a finer chop. Luminance only, tinted.
  const swell = (noise(x, y, 4, 2, 9001) - 0.5) * 40
  const chop = (noise(x, y, 8, 8, 9002) - 0.5) * 24
  return grey(206 + swell + chop + (pn(x, y, 9003) - 0.5) * 10)
})

// --- cross-shaped plants (alpha silhouettes, never tiled across a quad) -----
// Grass-family plants are biome-tinted at render time, so they are greyscale.
add('short_grass', tuft(206, 9601, 9, 5, 9))
add('fern', tuft(198, 9602, 11, 6, 10))
add('bush', tuft(190, 9603, 13, 4, 8))
add('tall_grass_bottom', tuft(202, 9604, 8, 10, 16))
add('tall_grass_top', tuft(212, 9605, 7, 4, 10))
add('large_fern_bottom', tuft(194, 9606, 10, 10, 16))
add('large_fern_top', tuft(206, 9607, 9, 5, 11))
// The rest carry their own colour.
add('dead_bush', tuft(0, 9608, 9, 5, 12, 0x6c4c22))
add('poppy', flower(0xc4342a, 0x2a1a14, 9611, 4, 9))
add('dandelion', flower(0xf3d33f, 0xd9a318, 9612, 4, 9))
add('lily_of_the_valley', flower(0xeeeee4, 0xcfcfc0, 9613, 4, 8, 2.6))
add('rose_bush_top', flower(0xbf2a2a, 0x741a1a, 9614, 3, 8))
add('rose_bush_bottom', tuft(0, 9615, 10, 9, 16, 0x3f6b2c))
add('brown_mushroom', mushroom(0xb08561, 0xd2cbbd, 9621, false))
add('red_mushroom', mushroom(0xc03a30, 0xd8d2c6, 9622, true))
add(
  'wheat_stage7',
  sprite((put) => {
    for (const bx of [2, 6, 10, 14]) {
      for (let y = 15; y >= 2; y--) {
        const d = (pn(bx, y, 9631) - 0.5) * 26
        put(bx, y, shade(rgb(0xb2913a), d))
        if (y <= 7) {
          put(bx - 1, y, shade(rgb(0xd7bd59), d)) // grain head
          put(bx + 1, y, shade(rgb(0x9c7d2a), d))
        }
      }
    }
  }),
)
add(
  'nether_wart_stage2',
  sprite((put) => {
    for (const bx of [3, 8, 12]) {
      for (let y = 15; y >= 7; y--) {
        put(bx, y, shade(rgb(0x7a1420), (pn(bx, y, 9641) - 0.5) * 30))
        if (y < 12) put(bx + 1, y, shade(rgb(0x5c0e18), (pn(bx, y, 9642) - 0.5) * 24))
      }
    }
  }),
)
add('sweet_berry_bush_stage3', (x, y) => {
  const c = cellular(x, y, 4, 9651, 1.0)
  if (c.f1 > 1.75 + (noise(x, y, 8, 8, 9652) - 0.5)) return grey(0, 0)
  if (pn(x, y, 9653) > 0.93) return shade(rgb(0xc03430), (pn(x, y, 9654) - 0.5) * 26) // berries
  return shade(rgb(0x3f6b2c), (1 - c.f1 / 2.4) * 30 - 12 + (pn(x, y, 9655) - 0.5) * 30)
})
add('leaf_litter', (x, y) => {
  const c = cellular(x, y, 5, 9661, 1.0)
  if (c.f1 > 1.25 + (noise(x, y, 8, 8, 9662) - 0.5) * 0.8) return grey(0, 0)
  const pick = hash(c.id, 2, 9663)
  const base = rgb(pick < 0.4 ? 0x8a6a2e : pick < 0.75 ? 0xa4762c : 0x6d5424)
  return shade(base, (1 - c.f1) * 12 + (pn(x, y, 9664) - 0.5) * 26)
})
add('glow_lichen', (x, y) => {
  // Ridged noise: thin veins where two smooth fields cross their mid-points.
  const vein =
    Math.abs(noise(x, y, 4, 4, 9671) - 0.5) + Math.abs(noise(x, y, 8, 8, 9672) - 0.5) * 0.7
  if (vein > 0.24) return grey(0, 0)
  return shade(rgb(0x7d9279), (0.24 - vein) * 90 - 10 + (pn(x, y, 9673) - 0.5) * 34)
})
add('moss_carpet', (x, y) => {
  const base = rgb(0x5a6e21)
  const clump = cellular(x, y, 4, 2801, 1.0)
  const lobe = (0.9 - Math.min(1, clump.f1 / 2.4)) * 22
  return shade(base, lobe + (pn(x, y, 2802) - 0.5) * 34 + (noise(x, y, 8, 8, 2803) - 0.5) * 24)
})

// --- trapdoors (their own art, with real gaps between the boards) ----------
add('spruce_trapdoor', trapdoor(0x6f5334, 9701), 'frame')
add('dark_oak_trapdoor', trapdoor(0x4b3319, 9702), 'frame')
add('oak_trapdoor', trapdoor(0xa4834d, 9703), 'frame')
add('jungle_trapdoor', trapdoor(0xa07550, 9704), 'frame')

// --- utility blocks with per-face art --------------------------------------
const FURNACE_STONE = rock(0x7c7c7c, 9801, 18)
add('furnace_side', panel(FURNACE_STONE), 'frame')
add('furnace_bottom', panel(FURNACE_STONE), 'frame')
add(
  'furnace_top',
  panel((x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5)
    if (d < 4.4 && d > 3.0) return shade(rgb(0x4a4a4a), (pn(x, y, 9802) - 0.5) * 20)
    return FURNACE_STONE(x, y)
  }),
  'frame',
)
add(
  'furnace_front',
  panel((x, y) => {
    if (inRect(x, y, 4, 7, 11, 13)) {
      const lit = y >= 12 ? 40 : 0 // embers behind the grate
      return shade(rgb(0x1b1b1b), lit + (pn(x, y, 9803) - 0.5) * 26)
    }
    if (inRect(x, y, 3, 6, 12, 6)) return shade(rgb(0x5d5d5d), -10) // lintel
    return FURNACE_STONE(x, y)
  }),
  'frame',
)
const BLAST_STONE = rock(0x5c5c5e, 9811, 18)
add('blast_furnace_side', panel(BLAST_STONE), 'frame')
add('blast_furnace_bottom', panel(BLAST_STONE), 'frame')
add(
  'blast_furnace_top',
  panel((x, y) => {
    if (inRect(x, y, 4, 4, 11, 11)) return shade(rgb(0x3a3a3c), (pn(x, y, 9812) - 0.5) * 20)
    return BLAST_STONE(x, y)
  }),
  'frame',
)
add(
  'blast_furnace_front',
  panel((x, y) => {
    if (inRect(x, y, 3, 8, 12, 13)) {
      return shade(rgb(0x171717), (y >= 12 ? 46 : 0) + (pn(x, y, 9813) - 0.5) * 26)
    }
    // two rivet holes above the mouth
    if (Math.hypot(x - 5.5, y - 5) < 1.6 || Math.hypot(x - 10.5, y - 5) < 1.6) {
      return shade(rgb(0x2c2c2e), (pn(x, y, 9814) - 0.5) * 18)
    }
    return BLAST_STONE(x, y)
  }),
  'frame',
)
const SMITH_WOOD = planks(0x3a322c, 9821)
add('smithing_table_bottom', panel(SMITH_WOOD), 'frame')
add(
  'smithing_table_top',
  panel((x, y) =>
    shade(rgb(0x3e434f), (pn(x, y, 9822) - 0.5) * 26 + (inRect(x, y, 3, 3, 12, 6) ? 16 : 0)),
  ),
  'frame',
)
add(
  'smithing_table_side',
  panel((x, y) => (y < 4 ? shade(rgb(0x3e434f), (pn(x, y, 9823) - 0.5) * 24) : SMITH_WOOD(x, y))),
  'frame',
)
add(
  'smithing_table_front',
  panel((x, y) => {
    if (y < 4) return shade(rgb(0x3e434f), (pn(x, y, 9824) - 0.5) * 24)
    if (inRect(x, y, 4, 7, 11, 11)) return shade(rgb(0x2a241f), (pn(x, y, 9825) - 0.5) * 20)
    return SMITH_WOOD(x, y)
  }),
  'frame',
)
const BARREL_WOOD = planks(0x8a6a3c, 9831)
add(
  'barrel_side',
  panel((x, y) => {
    if (y === 2 || y === 13) return shade(rgb(0x6a5a4a), (pn(x, y, 9832) - 0.5) * 18) // hoops
    return BARREL_WOOD(x, y)
  }),
  'frame',
)
add(
  'barrel_top',
  panel((x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5)
    if (d < 2.0) return shade(rgb(0x5c4a34), (pn(x, y, 9833) - 0.5) * 20) // bung
    if (d < 5.4 && d > 4.4) return shade(rgb(0x6a5a4a), (pn(x, y, 9834) - 0.5) * 16)
    return BARREL_WOOD(x, y)
  }),
  'frame',
)
add('barrel_bottom', panel(BARREL_WOOD), 'frame')
const CHEST_WOOD = planks(0x9c7f4e, 9841)
const chestFace = (extra: (x: number, y: number) => Px | null): PixelFn =>
  panel((x, y) => {
    if (y === 4 || y === 5) return shade(rgb(0x6b5230), (pn(x, y, 9842) - 0.5) * 18) // lid seam
    return extra(x, y) ?? CHEST_WOOD(x, y)
  })
add('chest_top', chestFace(() => null), 'frame')
add('chest_side', chestFace(() => null), 'frame')
add(
  'chest_front',
  chestFace((x, y) =>
    inRect(x, y, 7, 4, 8, 8) ? shade(rgb(0x6e6e6e), (pn(x, y, 9843) - 0.5) * 26 + 10) : null,
  ),
  'frame',
)
const CRAFT_WOOD = planks(0x9c7f4e, 9851)
add(
  'crafting_table_top',
  panel((x, y) => {
    if (x === 5 || x === 10 || y === 5 || y === 10) return shade(rgb(0x6b5230), -6) // 3x3 grid
    return CRAFT_WOOD(x, y)
  }),
  'frame',
)
add(
  'crafting_table_side',
  panel((x, y) => (inRect(x, y, 2, 9, 13, 10) ? shade(rgb(0x6b5230), 0) : CRAFT_WOOD(x, y))),
  'frame',
)
add(
  'crafting_table_front',
  panel((x, y) => (inRect(x, y, 3, 3, 12, 5) ? shade(rgb(0x6b5230), 0) : CRAFT_WOOD(x, y))),
  'frame',
)

// --- remaining Hill-palette materials ---------------------------------------
add('cyan_terracotta', rock(0x53696a, 9901, 22, -16))
add('farmland_moist', (x, y) => {
  const base = rgb(0x4e3018)
  const furrow = y % 4 === 0 ? -16 : y % 4 === 1 ? 8 : 0
  return shade(base, furrow + (pn(x, y, 9902) - 0.5) * 20 + (noise(x, y, 8, 8, 9903) - 0.5) * 16)
})
add('warped_stem', logSide(0x2b4f52, 9911))
add('warped_stem_top', logTop(0x3a7a73, 0x2b4f52, 9911), 'frame')
add('stripped_warped_stem', logSide(0x38878a, 9912, 22))
add('stripped_warped_stem_top', logTop(0x3a9a92, 0x38878a, 9912), 'frame')
alias('warped_hyphae', 'warped_stem')
alias('stripped_warped_hyphae', 'stripped_warped_stem')
alias('stripped_warped_hyphae_top', 'stripped_warped_stem_top')
add('prismarine', cobble(0x639a8f, 9921, 4, -30))
add('prismarine_bricks', bricks(0x62b0a2, 9922, 8, 4, 0x4e8d82))
add('dark_prismarine', rock(0x33574a, 9923, 22, -18))
add('oxidized_cut_copper', bricks(0x53a486, 9931, 8, 8, 0x3f8068))
add('shroomlight', (x, y) => {
  const c = cellular(x, y, 4, 9941, 1.0)
  return shade(rgb(0xd97a2a), (c.edge < 0.7 ? -34 : 26) + (pn(x, y, 9942) - 0.5) * 30)
})
add('deepslate_tiles', bricks(0x393a3e, 9951, 8, 8, 0x282a2d))
add('chiseled_stone_bricks', (x, y) => {
  const base = rgb(0x7a7a7a)
  // Carved panel edges. Wrapped, so the frame continues across tiled copies.
  if (wrap(x, S) === 0 || wrap(y, S) === 0 || wrap(y, S) === 8) return shade(base, -34)
  return shade(base, (pn(x, y, 9961) - 0.5) * 20 + (noise(x, y, 4, 8, 9962) - 0.5) * 26)
})
add('polished_granite', rock(0x9a6a55, 9971, 16))
add('coal_block', rock(0x131313, 9981, 22, 16))
add('lava_still', (x, y) => {
  const flow = noise(x, y, 4, 4, 9991) * 0.7 + noise(x, y, 8, 8, 9992) * 0.3
  const hot = flow > 0.56
  return shade(rgb(hot ? 0xf3a01d : 0xc23b0c), (pn(x, y, 9993) - 0.5) * 26 + (flow - 0.5) * 40)
})

// --- tiling check -----------------------------------------------------------

/** Mean absolute RGBA difference between two columns (axis 0) or rows (axis 1). */
function seam(tile: Tile, a: number, b: number, axis: 0 | 1): number {
  let sum = 0
  for (let k = 0; k < S; k++) {
    const ia = (axis === 0 ? k * S + a : a * S + k) * 4
    const ib = (axis === 0 ? k * S + b : b * S + k) * 4
    for (let c = 0; c < 4; c++) sum += Math.abs(tile[ia + c] - tile[ib + c])
  }
  return sum / (S * 4)
}

/**
 * Tileability, which is mandatory: these tiles repeat across large greedy-meshed
 * quads, so any seam shows up as a grid over the whole build.
 *
 * Every generator is built from wrapping noise, so the honest check is exact —
 * the pixel function must be 16-periodic on each axis it repeats along.
 *  - 'both':  periodic on x and y.
 *  - 'x':     deliberately banded top to bottom (as the vanilla equivalents
 *             are), so only x is checked.
 *  - 'frame': a 1px border on all four sides; tiling comes from opposite edges
 *             matching, not from periodicity, so compare the wrap seam against
 *             the worst seam inside the tile.
 */
function assertTiles(name: string, fn: PixelFn, tile: Tile, axes: Axes): void {
  if (axes === 'frame') {
    for (const axis of [0, 1] as const) {
      let worst = 0
      for (let i = 0; i < S - 1; i++) worst = Math.max(worst, seam(tile, i, i + 1, axis))
      const edge = seam(tile, S - 1, 0, axis)
      if (edge > worst) {
        throw new Error(
          `${name} does not tile on ${axis === 0 ? 'x' : 'y'}: ` +
            `wrap seam ${edge.toFixed(1)} vs worst interior seam ${worst.toFixed(1)}`,
        )
      }
    }
    return
  }
  for (const axis of [0, 1] as const) {
    if (axis === 1 && axes === 'x') continue
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const here = fn(x, y)
        const over = axis === 0 ? fn(x + S, y) : fn(x, y + S)
        if (here.some((v, i) => clamp(v) !== clamp(over[i]))) {
          throw new Error(
            `${name} is not ${axis === 0 ? 'x' : 'y'}-periodic at ${x},${y}: ` +
              `${here.map(clamp)} vs ${over.map(clamp)}`,
          )
        }
      }
    }
  }
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)))
  return out
}

/**
 * Minimal 8-bit RGBA PNG, filter type 0 on every row. Adaptive filtering was
 * tried and made the archive *larger*: these tiles are deliberately noisy, so
 * the delta filters raise entropy instead of lowering it.
 */
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// --- contact sheet (verification aid) ---------------------------------------

function contactSheet(scale: number, cols: number): Uint8Array {
  const repeats: string[] = ['cobblestone', 'oak_planks', 'spruce_leaves']
  const rows = Math.ceil(pack.length / cols) + 3 // 3 extra rows for the 3x3 repeats
  const w = cols * S * scale
  const h = rows * S * scale
  const out = new Uint8Array(w * h * 4)
  const blit = (tile: Tile, ox: number, oy: number): void => {
    for (let y = 0; y < S * scale; y++) {
      for (let x = 0; x < S * scale; x++) {
        const s = (Math.floor(y / scale) * S + Math.floor(x / scale)) * 4
        const d = ((oy + y) * w + ox + x) * 4
        // Checkerboard behind, so transparent pixels read as transparent.
        const bg = (Math.floor((ox + x) / 8) + Math.floor((oy + y) / 8)) % 2 === 0 ? 190 : 120
        const a = tile[s + 3] / 255
        out[d] = clamp(mix(bg, tile[s], a))
        out[d + 1] = clamp(mix(bg, tile[s + 1], a))
        out[d + 2] = clamp(mix(bg, tile[s + 2], a))
        out[d + 3] = 255
      }
    }
  }
  pack.forEach(({ tile }, i) => {
    blit(tile, (i % cols) * S * scale, Math.floor(i / cols) * S * scale)
  })
  const base = Math.ceil(pack.length / cols) * S * scale
  repeats.forEach((name, i) => {
    const tile = pack.find((t) => t.name === name)!.tile
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        blit(tile, (i * 3 + tx) * S * scale, base + ty * S * scale)
      }
    }
  })
  return encodePng(w, h, out)
}

// --- main --------------------------------------------------------------------

const names = new Set<string>()
for (const { name, fn, tile, axes } of pack) {
  if (names.has(name)) throw new Error(`duplicate texture ${name}`)
  names.add(name)
  assertTiles(name, fn, tile, axes)
}

const mcmeta = JSON.stringify(
  {
    pack: {
      pack_format: PACK_FORMAT,
      description: 'litematica-builder default textures - original art, CC0',
    },
  },
  null,
  2,
)

const files: Record<string, Uint8Array> = { 'pack.mcmeta': new TextEncoder().encode(mcmeta + '\n') }
for (const { name, tile } of pack) {
  files[`assets/minecraft/textures/block/${name}.png`] = encodePng(S, S, tile)
}

// A fixed mtime and deflate level keep the archive byte-identical run to run.
// Built from local-time components so the DOS timestamp is the same in any
// timezone (fflate reads getFullYear()/getMonth()/... off the Date).
const MTIME = new Date(1980, 0, 2, 12, 0, 0)
const zip = zipSync(files, { level: 9, mtime: MTIME })
const zipPath = resolve(ROOT, 'public/default-pack.zip')
mkdirSync(dirname(zipPath), { recursive: true })
writeFileSync(zipPath, zip)
console.log(`${pack.length} textures -> ${zipPath} (${zip.length} bytes)`)

const sheetFlag = process.argv.indexOf('--sheet')
if (sheetFlag !== -1 && process.argv[sheetFlag + 1]) {
  const path = resolve(process.argv[sheetFlag + 1])
  writeFileSync(path, contactSheet(6, 10))
  console.log(`contact sheet -> ${path}`)
  console.log(pack.map((t, i) => `${i}:${t.name}`).join(' '))
}
