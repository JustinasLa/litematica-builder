import './style.css'
import hillUrl from '../Hill.litematic?url'
import { loadLitematic, type Schematic } from './litematic'
import { Viewer } from './scene'

const app = document.querySelector<HTMLDivElement>('#app')!

const overlay = document.createElement('div')
overlay.id = 'overlay'
overlay.innerHTML = `
  <h1 id="title">Litematica viewer</h1>
  <dl>
    <dt>Author</dt><dd id="author">-</dd>
    <dt>Size</dt><dd id="dims">-</dd>
    <dt>Blocks</dt><dd id="blocks">-</dd>
    <dt>Rendered</dt><dd id="instances">-</dd>
  </dl>
  <div id="status">Loading...</div>
  <div id="controls">
    <input id="file" type="file" accept=".litematic" />
    ...or drop a .litematic file anywhere.
  </div>`
document.body.appendChild(overlay)

const el = (id: string) => document.getElementById(id)!
const status = el('status')

function setStatus(text: string, isError = false): void {
  status.textContent = text
  status.classList.toggle('error', isError)
}

let viewer: Viewer
try {
  viewer = new Viewer(app)
} catch (error) {
  setStatus(
    `Could not start the 3D viewer (WebGL unavailable): ${error instanceof Error ? error.message : String(error)}`,
    true,
  )
  throw error
}

function describe(schematic: Schematic, instances: number): void {
  el('title').textContent = schematic.name
  el('author').textContent = schematic.author || '-'
  const { x, y, z } = schematic.size
  el('dims').textContent = `${Math.abs(x)}x${Math.abs(y)}x${Math.abs(z)}`
  el('blocks').textContent = schematic.totalBlocks.toLocaleString()
  el('instances').textContent = instances.toLocaleString()
}

async function load(name: string, data: () => Promise<ArrayBuffer>): Promise<void> {
  setStatus(`Loading ${name}...`)
  try {
    const schematic = await loadLitematic(await data())
    describe(schematic, viewer.show(schematic))
    setStatus(`${schematic.regions.length} region(s) loaded.`)
  } catch (error) {
    // Keep whatever is already on screen; just say what went wrong.
    setStatus(`Could not load ${name}: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

function loadFile(file: File): void {
  void load(file.name, () => file.arrayBuffer())
}

el('file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) loadFile(file)
})

// Bound to the window: #overlay is painted on top of #app, and the drop hint
// lives inside it, so an #app-only handler lets the browser navigate the tab.
let dragDepth = 0
addEventListener('dragenter', () => {
  dragDepth++
  app.classList.add('dragging')
})
addEventListener('dragover', (event) => event.preventDefault())
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) app.classList.remove('dragging')
})
addEventListener('drop', (event) => {
  event.preventDefault()
  dragDepth = 0
  app.classList.remove('dragging')
  const file = event.dataTransfer?.files[0]
  if (file) loadFile(file)
})

void load('Hill.litematic', async () => {
  const response = await fetch(hillUrl)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.arrayBuffer()
})
