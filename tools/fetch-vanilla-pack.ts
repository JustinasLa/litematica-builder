/**
 * Downloads Mojang's official 1.21.10 client jar, verifies its sha1 against
 * the version manifest, and repacks the block textures it contains into
 * `public/default-pack.zip` — unmodified, byte-for-byte.
 *
 *   node tools/fetch-vanilla-pack.ts
 *
 * Only `assets/minecraft/textures/block/*.png` and their sibling
 * `*.png.mcmeta` animation-metadata files are extracted. No models,
 * blockstates, items, sounds, or code. Nothing is resampled, re-encoded,
 * cropped, or otherwise altered — bytes in, bytes out.
 *
 * The client jar is downloaded to a temp path outside the repo and never
 * committed; only the extracted textures are.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync, zlibSync, type Zippable } from 'fflate'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MC_VERSION = '1.21.10'
const PACK_FORMAT = 64 // 1.21.10
const BLOCK_TEXTURE_PREFIX = 'assets/minecraft/textures/block/'
// A fixed mtime keeps the archive byte-identical run to run (fflate rejects mtime: 0).
const MTIME = new Date(1980, 0, 2, 12, 0, 0)

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  return res.json()
}

async function main(): Promise<void> {
  console.log(`Fetching version manifest...`)
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
  const entry = manifest.versions.find((v: { id: string }) => v.id === MC_VERSION)
  if (!entry) throw new Error(`version ${MC_VERSION} not found in manifest`)

  console.log(`Fetching version metadata for ${MC_VERSION}...`)
  const versionJson = await fetchJson(entry.url)
  const clientUrl: string = versionJson.downloads.client.url
  const clientSha1: string = versionJson.downloads.client.sha1

  const tmpDir = mkdtempSync(join(tmpdir(), 'litematica-vanilla-jar-'))
  const jarPath = join(tmpDir, 'client.jar')
  try {
    console.log(`Downloading client jar from ${clientUrl} ...`)
    const res = await fetch(clientUrl)
    if (!res.ok) throw new Error(`GET ${clientUrl} -> ${res.status} ${res.statusText}`)
    const jarBytes = new Uint8Array(await res.arrayBuffer())

    const actualSha1 = createHash('sha1').update(jarBytes).digest('hex')
    if (actualSha1 !== clientSha1) {
      throw new Error(`sha1 mismatch: expected ${clientSha1}, got ${actualSha1}. Refusing to use this jar.`)
    }
    writeFileSync(jarPath, jarBytes)
    console.log(`Verified sha1: ${actualSha1}`)

    const jar = unzipSync(jarBytes, {
      filter: (file) =>
        file.name.startsWith(BLOCK_TEXTURE_PREFIX) &&
        (file.name.endsWith('.png') || file.name.endsWith('.png.mcmeta')),
    })

    const names = Object.keys(jar).sort()
    if (names.length === 0) throw new Error('no block textures found in jar')

    const mcmeta = JSON.stringify(
      {
        pack: {
          pack_format: PACK_FORMAT,
          description: 'Vanilla Minecraft block textures, Mojang AB',
        },
      },
      null,
      2,
    )

    const files: Zippable = {
      'pack.mcmeta': [new TextEncoder().encode(mcmeta + '\n'), { level: 9, mtime: MTIME }],
    }
    for (const name of names) {
      const data = jar[name]
      // PNGs are already compressed; deflating them can lose to plain storage.
      // Try both and keep whichever is smaller.
      const deflated = zlibSync(data, { level: 9 })
      const level = deflated.length < data.length ? 9 : 0
      files[name] = [data, { level, mtime: MTIME }]
    }

    const zip = zipSync(files, { mtime: MTIME })
    const zipPath = resolve(ROOT, 'public/default-pack.zip')
    mkdirSync(dirname(zipPath), { recursive: true })
    writeFileSync(zipPath, zip)

    console.log(`Version: ${MC_VERSION}`)
    console.log(`Jar sha1: ${actualSha1}`)
    console.log(`Entries: ${names.length}`)
    console.log(`Output: ${zipPath} (${zip.length} bytes)`)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
