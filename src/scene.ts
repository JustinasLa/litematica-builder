import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { blockColour, isAir, isOpaque } from './blocks'
import type { Schematic } from './litematic'

const NEIGHBOURS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const

/** Blocks that are visible: not air, and not completely enclosed by opaque blocks. */
function visibleBlocks(schematic: Schematic): { positions: Float32Array; colours: Float32Array } {
  const positions: number[] = []
  const colours: number[] = []
  const colour = new THREE.Color()

  for (const region of schematic.regions) {
    const { size, min, palette, blocks } = region
    const air = palette.map((b) => isAir(b.name))
    const opaque = palette.map((b) => isOpaque(b.name))
    const rgb = palette.map((b) => blockColour(b.name))
    const strideZ = size.x
    const strideY = size.x * size.z

    for (let y = 0; y < size.y; y++) {
      for (let z = 0; z < size.z; z++) {
        for (let x = 0; x < size.x; x++) {
          const index = blocks[y * strideY + z * strideZ + x]!
          if (air[index]) continue

          let hidden = true
          for (const [dx, dy, dz] of NEIGHBOURS) {
            const nx = x + dx
            const ny = y + dy
            const nz = z + dz
            if (nx < 0 || ny < 0 || nz < 0 || nx >= size.x || ny >= size.y || nz >= size.z) {
              hidden = false // outside the region counts as absent, so the hull is drawn
              break
            }
            if (!opaque[blocks[ny * strideY + nz * strideZ + nx]!]) {
              hidden = false
              break
            }
          }
          if (hidden) continue

          positions.push(min.x + x + 0.5, min.y + y + 0.5, min.z + z + 0.5)
          colour.setHex(rgb[index]!, THREE.SRGBColorSpace)
          colours.push(colour.r, colour.g, colour.b)
        }
      }
    }
  }
  return { positions: new Float32Array(positions), colours: new Float32Array(colours) }
}

export class Viewer {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private mesh: THREE.InstancedMesh | null = null
  // Reused every frame; nothing is allocated in the render loop.
  private readonly matrix = new THREE.Matrix4()
  private readonly box = new THREE.Box3()
  private readonly centre = new THREE.Vector3()
  private readonly extent = new THREE.Vector3()

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
    this.renderer.render(this.scene, this.camera)
  }

  /** Replace the rendered schematic. Returns the instance count actually drawn. */
  show(schematic: Schematic): number {
    this.clear()
    const { positions, colours } = visibleBlocks(schematic)
    const count = positions.length / 3

    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      Math.max(count, 1),
    )
    mesh.count = count
    for (let i = 0; i < count; i++) {
      this.matrix.makeTranslation(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
      mesh.setMatrixAt(i, this.matrix)
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3)
    mesh.instanceMatrix.needsUpdate = true
    this.mesh = mesh
    this.scene.add(mesh)

    this.frame(schematic)
    return count
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

  private clear(): void {
    if (!this.mesh) return
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
    this.mesh = null
  }
}
