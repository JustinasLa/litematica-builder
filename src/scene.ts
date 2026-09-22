import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { isAir, isOpaque } from './blocks'
import type { Region, Schematic } from './litematic'
import { fallbackTextures, type BlockTextures, type Face } from './textures'

/** Edge length of a meshing chunk. One THREE.Mesh (one draw call) per non-empty chunk. */
export const CHUNK = 32

/** Face index = axis * 2 + (dir > 0 ? 0 : 1), axis 0/1/2 = x/y/z. */
const FACES: readonly Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz']

/** One chunk of geometry, as plain typed arrays. No three.js objects, so it is testable. */
export interface ChunkMesh {
  /** World position of the chunk's minimum corner; `positions` are relative to it. */
  origin: [number, number, number]
  /** Chunk-local, so 16-bit is plenty. */
  positions: Uint16Array
  /** Signed-normalised; every component is exactly -1, 0 or 1. */
  normals: Int8Array
  /** Unsigned-normalised linear-space tint, one per vertex. */
  colors: Uint8Array
  /** Runs 0..width / 0..height so the array texture tiles across a merged quad. */
  tileUv: Uint16Array
  layers: Uint16Array
  indices: Uint16Array | Uint32Array
  quads: number
  /** Bounding sphere, chunk-local, like `positions`. */
  centre: [number, number, number]
  radius: number
}

interface Tables {
  air: Uint8Array
  opaque: Uint8Array
  /** [face * n + palette] */
  key: Int32Array
  layer: Float32Array
  /** 3 floats per [face * n + palette] */
  tint: Float32Array
}

function tablesFor(region: Region, textures: BlockTextures): Tables {
  const n = region.palette.length
  const t: Tables = {
    air: new Uint8Array(n),
    opaque: new Uint8Array(n),
    key: new Int32Array(6 * n),
    layer: new Float32Array(6 * n),
    tint: new Float32Array(3 * 6 * n),
  }
  const colour = new THREE.Color()
  for (let i = 0; i < n; i++) {
    const name = region.palette[i]!.name
    t.air[i] = isAir(name) ? 1 : 0
    t.opaque[i] = isOpaque(name) ? 1 : 0
    for (let f = 0; f < 6; f++) {
      const face = FACES[f]!
      t.key[f * n + i] = textures.faceKey(name, face)
      t.layer[f * n + i] = textures.layer(name, face)
      colour.setHex(textures.tint(name, face), THREE.SRGBColorSpace)
      const at = (f * n + i) * 3
      t.tint[at] = colour.r
      t.tint[at + 1] = colour.g
      t.tint[at + 2] = colour.b
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
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const

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
                  if (t.air[idx]) continue
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
                  for (const [su, sv] of corners) {
                    p[axis] = c0[axis]!
                    p[u] = c0[u]! + su * qw
                    p[v] = c0[v]! + sv * qh
                    positions.push(p[0]!, p[1]!, p[2]!)
                    normals.push(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0)
                    tileUv.push(su * qw, sv * qh)
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

        if (quads === 0) continue
        // Narrow formats, not floats: at a quarter-million quads the difference
        // is tens of megabytes of VRAM, and none of these need more range.
        yield {
          origin: [origin[0]! + lo[0]!, origin[1]! + lo[1]!, origin[2]! + lo[2]!],
          positions: new Uint16Array(positions),
          normals: Int8Array.from(normals, (n) => n * 127),
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
 * The chunk's own box in chunk-local coordinates, grown half a unit so a face
 * quad sitting on the far boundary still fits inside it.
 */
function boundsOf(lo: number[], hi: number[]): { centre: [number, number, number]; radius: number } {
  const centre: [number, number, number] = [0, 0, 0]
  let r2 = 0
  for (let a = 0; a < 3; a++) {
    const extent = hi[a]! - lo[a]!
    centre[a] = extent / 2
    const half = extent / 2 + 0.5
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
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, alphaTest: 0.5 })
  material.onBeforeCompile = (shader) => {
    shader.uniforms['blockTex'] = { value: textures.texture }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec2 aTileUv;\nattribute float aLayer;\nvarying vec2 vTileUv;\nflat varying float vLayer;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvTileUv = aTileUv;\nvLayer = aLayer;',
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
      const distance = this.scratch.copy(sphere.center).add(chunk.position).distanceTo(eye)
      chunk.visible = sphere.radius >= LOD_ANGULAR_SIZE * distance
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
