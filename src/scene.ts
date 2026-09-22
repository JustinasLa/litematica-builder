import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { baseName, isAir, isOpaque } from './blocks'
import type { Region, Schematic } from './litematic'
import { shapeFor, type Box } from './shapes'
import { fallbackTextures, type BlockTextures, type Face } from './textures'

/** Edge length of a meshing chunk. One THREE.Mesh (one draw call) per non-empty chunk. */
export const CHUNK = 32

/**
 * Positions are integers in 1/SUB of a block, and the mesh is scaled by 1/SUB:
 * non-cube shapes need sub-block coordinates, and this keeps them in the same
 * Uint16 attribute as the full cubes (32 * 256 = 8192, well inside 16 bits).
 */
export const SUB = 256

/**
 * Texture coordinates are integers in 1/TILE of a block. The injected vertex
 * shader divides by the same 16.0; keep the two in step.
 */
const TILE = 16

/** Face index = axis * 2 + (dir > 0 ? 0 : 1), axis 0/1/2 = x/y/z. */
const FACES: readonly Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz']

/** Quad corner order, in the face's own (u, v) basis. */
const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const

/**
 * Face -> face whose texture it takes, for a pillar's `axis` property. Without
 * this an axis=x log shows its bark on the ends and its rings on the sides.
 */
const AXIS_FACES: Record<string, readonly number[]> = {
  x: [2, 3, 0, 1, 4, 5],
  z: [0, 1, 4, 5, 2, 3],
}

/** One chunk of geometry, as plain typed arrays. No three.js objects, so it is testable. */
export interface ChunkMesh {
  /** World position of the chunk's minimum corner; `positions` are relative to it. */
  origin: [number, number, number]
  /** Chunk-local, in 1/SUB units, so 16-bit is plenty. */
  positions: Uint16Array
  /** Signed-normalised unit normals (not axis-aligned for cross plants). */
  normals: Int8Array
  /** Unsigned-normalised linear-space tint, one per vertex. */
  colors: Uint8Array
  /** In 1/TILE units, so the array texture tiles across a merged quad. */
  tileUv: Uint16Array
  layers: Uint16Array
  indices: Uint16Array | Uint32Array
  quads: number
  /** Bounding sphere, chunk-local and in 1/SUB units, like `positions`. */
  centre: [number, number, number]
  radius: number
}

/** One pre-resolved quad of a non-cube shape, relative to its block's corner. */
interface ShapeQuad {
  /** 4 corners, xyz, in 1/SUB units. */
  pos: number[]
  /** 4 uv pairs, in 1/TILE units. */
  uv: number[]
  n: [number, number, number]
  layer: number
  tint: [number, number, number]
  /** Face index (0..5) this quad sits on and may be culled against, else -1. */
  cull: number
  /** Reverse the winding: the quad faces down its axis. */
  flip: boolean
}

interface Tables {
  /** Air, or a shaped block: either way the greedy sweep must not see it. */
  skip: Uint8Array
  opaque: Uint8Array
  /** Pre-resolved shape quads per palette entry; null for full cubes. */
  shape: (ShapeQuad[] | null)[]
  shaped: boolean
  /** [face * n + palette] */
  key: Int32Array
  layer: Float32Array
  /** 3 floats per [face * n + palette] */
  tint: Float32Array
}

const scratchColour = new THREE.Color()

/** Linear-space rgb for a 0xRRGGBB sRGB tint. */
function linear(tint: number): [number, number, number] {
  scratchColour.setHex(tint, THREE.SRGBColorSpace)
  return [scratchColour.r, scratchColour.g, scratchColour.b]
}

/**
 * Vanilla's implicit face uv: the box's own coordinates, with u running right
 * and v running down as seen from outside the face. `p` is in 1/16 units.
 */
function faceUv(face: number, p: number[]): [number, number] {
  const [x, y, z] = p as [number, number, number]
  switch (face) {
    case 0:
      return [16 - z, 16 - y] // px, east
    case 1:
      return [z, 16 - y] // nx, west
    case 2:
      return [x, z] // py, top
    case 3:
      return [x, 16 - z] // ny, bottom
    case 4:
      return [x, 16 - y] // pz, south
    default:
      return [16 - x, 16 - y] // nz, north
  }
}

/** Expand one shape box into its (up to) six textured quads. */
function bakeBox(b: Box, blockName: string, textures: BlockTextures, out: ShapeQuad[]): void {
  const from = b.from
  const to = b.to
  for (let f = 0; f < 6; f++) {
    const axis = f >> 1
    const dir = f & 1 ? -1 : 1
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    // A zero-area face of a flattened box (a lichen quad) is not a face.
    if (to[u]! <= from[u]! || to[v]! <= from[v]!) continue

    const w = dir > 0 ? to[axis]! : from[axis]!
    const p = [0, 0, 0]
    const pos: number[] = []
    const uv: number[] = []
    for (const [su, sv] of CORNERS) {
      p[axis] = w
      p[u] = su ? to[u]! : from[u]!
      p[v] = sv ? to[v]! : from[v]!
      pos.push(...p.map((c) => Math.round((c * SUB) / 16)))
      uv.push(...faceUv(f, p).map(Math.round))
    }

    // Only a face lying exactly on the block boundary may be culled; every
    // interior face is always drawn. A flattened box has no boundary face.
    const flat = from[axis] === to[axis]
    const onBoundary = dir > 0 ? to[axis] === 16 : from[axis] === 0
    const ref = b.tex
      ? textures.ref(b.tex, blockName)
      : {
          layer: textures.layer(blockName, FACES[f]!),
          tint: textures.tint(blockName, FACES[f]!),
        }
    out.push({
      pos,
      uv,
      n: [axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0],
      layer: ref.layer,
      tint: linear(ref.tint),
      cull: !flat && onBoundary ? f : -1,
      flip: dir < 0,
    })
  }
}

/** Vanilla's cross: two diagonal quads, each emitted mirrored so both faces show. */
function bakeCross(tex: string, blockName: string, textures: BlockTextures, out: ShapeQuad[]): void {
  const ref = textures.ref(tex, blockName)
  const tint = linear(ref.tint)
  const a = 0.8
  const b = 15.2
  for (const [x0, z0, x1, z1] of [
    [a, a, b, b],
    [a, b, b, a],
  ] as const) {
    const s = SUB / 16
    const pos = [x0 * s, 0, z0 * s, x1 * s, 0, z1 * s, x1 * s, SUB, z1 * s, x0 * s, SUB, z0 * s].map(
      Math.round,
    )
    const uv = [0, 16, 16, 16, 16, 0, 0, 0]
    const len = Math.hypot(x1 - x0, z1 - z0)
    const n: [number, number, number] = [-(z1 - z0) / len, 0, (x1 - x0) / len]
    // ponytail: the mirrored copy stands in for a DoubleSide material, which
    // would cost a second mesh and draw call per chunk for a handful of quads.
    out.push({ pos, uv, n, layer: ref.layer, tint, cull: -1, flip: false })
    out.push({ pos, uv, n: [-n[0], 0, -n[2]], layer: ref.layer, tint, cull: -1, flip: true })
  }
}

function bakeShape(
  blockName: string,
  properties: Record<string, string>,
  textures: BlockTextures,
): ShapeQuad[] | null {
  const shape = shapeFor(baseName(blockName), properties)
  if (!shape) return null
  const out: ShapeQuad[] = []
  for (const b of shape.boxes) bakeBox(b, blockName, textures, out)
  for (const tex of shape.cross ?? []) bakeCross(tex, blockName, textures, out)
  return out.length > 0 ? out : null
}

function tablesFor(region: Region, textures: BlockTextures): Tables {
  const n = region.palette.length
  const t: Tables = {
    skip: new Uint8Array(n),
    opaque: new Uint8Array(n),
    shape: new Array<ShapeQuad[] | null>(n).fill(null),
    shaped: false,
    key: new Int32Array(6 * n),
    layer: new Float32Array(6 * n),
    tint: new Float32Array(3 * 6 * n),
  }
  for (let i = 0; i < n; i++) {
    const { name, properties } = region.palette[i]!
    const air = isAir(name)
    const shape = air ? null : bakeShape(name, properties, textures)
    t.shape[i] = shape
    if (shape) t.shaped = true
    t.skip[i] = air || shape ? 1 : 0
    t.opaque[i] = isOpaque(name, properties) ? 1 : 0
    // A pillar's texture assignment turns with its axis; its geometry does not.
    const turn = AXIS_FACES[properties['axis'] ?? 'y']
    for (let f = 0; f < 6; f++) {
      const face = FACES[turn ? turn[f]! : f]!
      t.key[f * n + i] = textures.faceKey(name, face)
      t.layer[f * n + i] = textures.layer(name, face)
      const [r, g, b] = linear(textures.tint(name, face))
      const at = (f * n + i) * 3
      t.tint[at] = r
      t.tint[at + 1] = g
      t.tint[at + 2] = b
    }
  }
  return t
}

/**
 * Greedy-mesh a schematic, one chunk at a time; only non-empty chunks are
 * yielded. A face is drawn iff the neighbour in that direction is absent
 * (outside the region counts as absent, so the hull is drawn) or non-opaque.
 * Adjacent faces merge into one quad iff their faceKeys are equal.
 */
export function* meshSchematic(
  schematic: Schematic,
  textures: BlockTextures,
  chunkSize = CHUNK,
): Generator<ChunkMesh> {
  for (const region of schematic.regions) {
    yield* meshRegion(region, textures, chunkSize)
  }
}

function* meshRegion(
  region: Region,
  textures: BlockTextures,
  chunkSize: number,
): Generator<ChunkMesh> {
  const t = tablesFor(region, textures)
  const n = region.palette.length
  const { blocks, size, min } = region
  const dim = [size.x, size.y, size.z]
  const origin = [min.x, min.y, min.z]
  const strideZ = size.x
  const strideY = size.x * size.z
  const at = (x: number, y: number, z: number): number => blocks[y * strideY + z * strideZ + x]!

  // Reused across every slice of every chunk; nothing is allocated in the sweep.
  const area = chunkSize * chunkSize
  const has = new Uint8Array(area)
  const key = new Int32Array(area)
  const pal = new Int32Array(area)
  const lo = [0, 0, 0]
  const hi = [0, 0, 0]
  const p = [0, 0, 0]
  const c0 = [0, 0, 0]

  for (let cz = 0; cz < dim[2]!; cz += chunkSize) {
    for (let cy = 0; cy < dim[1]!; cy += chunkSize) {
      for (let cx = 0; cx < dim[0]!; cx += chunkSize) {
        lo[0] = cx
        lo[1] = cy
        lo[2] = cz
        hi[0] = Math.min(cx + chunkSize, dim[0]!)
        hi[1] = Math.min(cy + chunkSize, dim[1]!)
        hi[2] = Math.min(cz + chunkSize, dim[2]!)

        const positions: number[] = []
        const normals: number[] = []
        const colors: number[] = []
        const tileUv: number[] = []
        const layers: number[] = []
        const indices: number[] = []
        let quads = 0

        for (let axis = 0; axis < 3; axis++) {
          const u = (axis + 1) % 3
          const v = (axis + 2) % 3
          const nu = hi[u]! - lo[u]!
          const nv = hi[v]! - lo[v]!

          for (let d = 0; d < 2; d++) {
            const dir = d === 0 ? 1 : -1
            const face = axis * 2 + d
            const keyBase = face * n
            const tintBase = face * n * 3

            for (let w = lo[axis]!; w < hi[axis]!; w++) {
              has.fill(0, 0, nu * nv)
              let any = false
              for (let vi = 0; vi < nv; vi++) {
                for (let ui = 0; ui < nu; ui++) {
                  p[axis] = w
                  p[u] = lo[u]! + ui
                  p[v] = lo[v]! + vi
                  const idx = at(p[0]!, p[1]!, p[2]!)
                  if (t.skip[idx]) continue
                  const nw = w + dir
                  if (nw >= 0 && nw < dim[axis]!) {
                    p[axis] = nw
                    if (t.opaque[at(p[0]!, p[1]!, p[2]!)]) continue
                  }
                  const cell = vi * nu + ui
                  has[cell] = 1
                  key[cell] = t.key[keyBase + idx]!
                  pal[cell] = idx
                  any = true
                }
              }
              if (!any) continue

              // Greedy merge: widen along u, then grow along v while the whole row matches.
              for (let vi = 0; vi < nv; vi++) {
                for (let ui = 0; ui < nu; ) {
                  const cell = vi * nu + ui
                  if (!has[cell]) {
                    ui++
                    continue
                  }
                  const k = key[cell]!
                  let qw = 1
                  while (ui + qw < nu && has[cell + qw] && key[cell + qw] === k) qw++
                  let qh = 1
                  grow: while (vi + qh < nv) {
                    const row = (vi + qh) * nu + ui
                    for (let i = 0; i < qw; i++) {
                      if (!has[row + i] || key[row + i] !== k) break grow
                    }
                    qh++
                  }
                  for (let dv = 0; dv < qh; dv++) {
                    has.fill(0, (vi + dv) * nu + ui, (vi + dv) * nu + ui + qw)
                  }

                  const idx = pal[cell]!
                  // Chunk-local: the mesh itself is translated to the chunk corner.
                  c0[axis] = (dir > 0 ? w + 1 : w) - lo[axis]!
                  c0[u] = ui
                  c0[v] = vi

                  const base = positions.length / 3
                  for (const [su, sv] of CORNERS) {
                    p[axis] = c0[axis]!
                    p[u] = c0[u]! + su * qw
                    p[v] = c0[v]! + sv * qh
                    positions.push(p[0]! * SUB, p[1]! * SUB, p[2]! * SUB)
                    normals.push(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0)
                    tileUv.push(su * qw * TILE, sv * qh * TILE)
                    layers.push(t.layer[keyBase + idx]!)
                    const c = tintBase + idx * 3
                    colors.push(t.tint[c]!, t.tint[c + 1]!, t.tint[c + 2]!)
                  }
                  // Counter-clockwise seen from the face's own side.
                  if (dir > 0) {
                    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
                  } else {
                    indices.push(base, base + 3, base + 2, base, base + 2, base + 1)
                  }
                  quads++
                  ui += qw
                }
              }
            }
          }
        }

        // Non-cube shapes: individual quads appended to the same chunk
        // geometry, so the draw-call count stays one per chunk.
        if (t.shaped) {
          for (let bz = lo[2]!; bz < hi[2]!; bz++) {
            for (let by = lo[1]!; by < hi[1]!; by++) {
              for (let bx = lo[0]!; bx < hi[0]!; bx++) {
                const shape = t.shape[at(bx, by, bz)]
                if (!shape) continue
                const ox = (bx - lo[0]!) * SUB
                const oy = (by - lo[1]!) * SUB
                const oz = (bz - lo[2]!) * SUB
                for (const q of shape) {
                  if (q.cull >= 0) {
                    const axis = q.cull >> 1
                    p[0] = bx
                    p[1] = by
                    p[2] = bz
                    p[axis] += q.cull & 1 ? -1 : 1
                    const inside = p[axis]! >= 0 && p[axis]! < dim[axis]!
                    if (inside && t.opaque[at(p[0]!, p[1]!, p[2]!)]) continue
                  }
                  const base = positions.length / 3
                  for (let c = 0; c < 4; c++) {
                    positions.push(ox + q.pos[c * 3]!, oy + q.pos[c * 3 + 1]!, oz + q.pos[c * 3 + 2]!)
                    normals.push(q.n[0], q.n[1], q.n[2])
                    tileUv.push(q.uv[c * 2]!, q.uv[c * 2 + 1]!)
                    layers.push(q.layer)
                    colors.push(q.tint[0], q.tint[1], q.tint[2])
                  }
                  if (q.flip) {
                    indices.push(base, base + 3, base + 2, base, base + 2, base + 1)
                  } else {
                    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
                  }
                  quads++
                }
              }
            }
          }
        }

        if (quads === 0) continue
        // Narrow formats, not floats: at a quarter-million quads the difference
        // is tens of megabytes of VRAM, and none of these need more range.
        yield {
          origin: [origin[0]! + lo[0]!, origin[1]! + lo[1]!, origin[2]! + lo[2]!],
          positions: new Uint16Array(positions),
          normals: Int8Array.from(normals, (n) => Math.round(n * 127)),
          colors: Uint8Array.from(colors, (c) => Math.round(c * 255)),
          tileUv: new Uint16Array(tileUv),
          layers: new Uint16Array(layers),
          indices: quads * 4 <= 0x10000 ? new Uint16Array(indices) : new Uint32Array(indices),
          quads,
          ...boundsOf(lo, hi),
        }
      }
    }
  }
}

/**
 * The chunk's own box in chunk-local 1/SUB coordinates, grown half a block so a
 * face quad sitting on the far boundary still fits inside it.
 */
function boundsOf(lo: number[], hi: number[]): { centre: [number, number, number]; radius: number } {
  const centre: [number, number, number] = [0, 0, 0]
  let r2 = 0
  for (let a = 0; a < 3; a++) {
    const extent = (hi[a]! - lo[a]!) * SUB
    centre[a] = extent / 2
    const half = extent / 2 + SUB / 2
    r2 += half * half
  }
  return { centre, radius: Math.sqrt(r2) }
}

function geometryOf(chunk: ChunkMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3, true))
  g.setAttribute('color', new THREE.BufferAttribute(chunk.colors, 3, true))
  g.setAttribute('aTileUv', new THREE.BufferAttribute(chunk.tileUv, 2))
  g.setAttribute('aLayer', new THREE.BufferAttribute(chunk.layers, 1))
  g.setIndex(new THREE.BufferAttribute(chunk.indices, 1))
  // Set explicitly: three would otherwise scan every vertex, and the chunk's
  // bounds are known up front. Frustum culling depends on this being right.
  g.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(chunk.centre[0], chunk.centre[1], chunk.centre[2]),
    chunk.radius,
  )
  return g
}

/**
 * MeshLambertMaterial (three's lighting and fog, for free) taught to sample a
 * DataArrayTexture. Cutouts use alphaTest, not `transparent`: sorting thousands
 * of quads every frame costs far more than it buys.
 */
function materialFor(textures: BlockTextures): THREE.MeshLambertMaterial {
  // alphaTest is deliberately low: mipmap averaging drags a binary-alpha cutout
  // below 0.5 at distance, which dissolves thin plant quads.
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, alphaTest: 0.2 })
  material.onBeforeCompile = (shader) => {
    shader.uniforms['blockTex'] = { value: textures.texture }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec2 aTileUv;\nattribute float aLayer;\nvarying vec2 vTileUv;\nflat varying float vLayer;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvTileUv = aTileUv / 16.0;\nvLayer = aLayer;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2DArray blockTex;\nvarying vec2 vTileUv;\nflat varying float vLayer;',
      )
      .replace(
        '#include <map_fragment>',
        'diffuseColor *= texture( blockTex, vec3( vTileUv, vLayer ) );',
      )
  }
  return material
}

/** Below this apparent size (radius / distance) a chunk is a few pixels; skip it. */
const LOD_ANGULAR_SIZE = 0.004

export class Viewer {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private chunks: THREE.Mesh[] = []
  private material: THREE.MeshLambertMaterial | null = null
  private schematic: Schematic | null = null
  private textures: BlockTextures | null = null
  /** Only a texture set we made ourselves is ours to dispose. */
  private ownsTextures = false
  /** Bumped on every show()/clear(); an in-flight meshing loop stops when it changes. */
  private generation = 0
  // Reused every frame; nothing is allocated in the render loop.
  private readonly box = new THREE.Box3()
  private readonly centre = new THREE.Vector3()
  private readonly extent = new THREE.Vector3()
  private readonly scratch = new THREE.Vector3()

  constructor(parent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.canvas = this.renderer.domElement
    parent.appendChild(this.canvas)

    this.scene.background = new THREE.Color(0x11141a)
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000)
    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 1.9)
    key.position.set(1, 2.2, 0.75)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.7)
    fill.position.set(-1.2, 0.6, -1)
    this.scene.add(fill)

    addEventListener('resize', this.resize)
    this.resize()
    this.renderer.setAnimationLoop(this.tick)
  }

  private resize = (): void => {
    const width = this.canvas.clientWidth || innerWidth
    const height = this.canvas.clientHeight || innerHeight
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private tick = (): void => {
    this.controls.update()
    // LOD: hide chunks that have shrunk to a few pixels. Cheaper than meshing a
    // coarse stand-in, and three still frustum-culls whatever is left visible.
    const eye = this.camera.position
    for (const chunk of this.chunks) {
      const sphere = chunk.geometry.boundingSphere!
      // The geometry, and so the sphere, is in 1/SUB units; scale it back.
      const scale = chunk.scale.x
      const distance = this.scratch
        .copy(sphere.center)
        .multiplyScalar(scale)
        .add(chunk.position)
        .distanceTo(eye)
      chunk.visible = sphere.radius * scale >= LOD_ANGULAR_SIZE * distance
    }
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Replace the rendered schematic. Resolves with the number of quads drawn,
   * having yielded to the event loop between chunks so the tab stays live and
   * the build appears progressively.
   */
  async show(schematic: Schematic): Promise<number> {
    this.clear()
    this.schematic = schematic
    if (!this.textures) {
      this.textures = fallbackTextures()
      this.ownsTextures = true
    }
    this.frame(schematic)

    const generation = this.generation
    const material = materialFor(this.textures)
    this.material = material

    let quads = 0
    let deadline = performance.now() + 16
    for (const chunk of meshSchematic(schematic, this.textures)) {
      if (generation !== this.generation) return quads
      const mesh = new THREE.Mesh(geometryOf(chunk), material)
      mesh.position.set(chunk.origin[0], chunk.origin[1], chunk.origin[2])
      mesh.scale.setScalar(1 / SUB)
      this.chunks.push(mesh)
      this.scene.add(mesh)
      quads += chunk.quads
      if (performance.now() >= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        deadline = performance.now() + 16
      }
    }
    return quads
  }

  /** Re-mesh what is on screen with a new texture set (a pack can arrive late). */
  async setTextures(textures: BlockTextures): Promise<number> {
    if (this.ownsTextures) this.textures?.texture.dispose()
    this.textures = textures
    this.ownsTextures = false
    const schematic = this.schematic
    return schematic ? this.show(schematic) : 0
  }

  private frame(schematic: Schematic): void {
    this.box.makeEmpty()
    for (const r of schematic.regions) {
      this.box.expandByPoint(this.centre.set(r.min.x, r.min.y, r.min.z))
      this.box.expandByPoint(
        this.centre.set(r.min.x + r.size.x, r.min.y + r.size.y, r.min.z + r.size.z),
      )
    }
    if (this.box.isEmpty()) this.box.setFromCenterAndSize(this.centre.set(0, 0, 0), this.extent.set(1, 1, 1))
    this.box.getCenter(this.centre)
    this.box.getSize(this.extent)

    const radius = this.extent.length() / 2 || 1
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360)
    this.camera.far = distance * 10
    // Keep the orbit inside the far plane: scrolling past it culls every chunk.
    this.controls.maxDistance = distance * 3
    this.camera.near = Math.max(0.1, distance / 1000)
    this.camera.updateProjectionMatrix()
    this.camera.position.set(
      this.centre.x + distance * 0.7,
      this.centre.y + distance * 0.5,
      this.centre.z + distance * 0.7,
    )
    this.controls.target.copy(this.centre)
    this.controls.update()
  }

  /** Drop every chunk and free its GPU buffers. Textures are not freed here. */
  clear(): void {
    this.generation++
    for (const mesh of this.chunks) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
    }
    this.chunks = []
    this.material?.dispose()
    this.material = null
    this.schematic = null
  }
}
