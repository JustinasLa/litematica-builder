# tools

`fetch-vanilla-pack.ts` generates `public/default-pack.zip`, the resource pack
the app loads on startup so a build renders textured with no user action.

It downloads Mojang's official Minecraft 1.21.10 client jar (from the public
version manifest at `piston-meta.mojang.com`), **verifies the jar's sha1
against the sha1 published in that manifest before using it** (refuses to
proceed on a mismatch), and extracts only
`assets/minecraft/textures/block/*.png` and their sibling `*.png.mcmeta`
animation-metadata files — nothing else from the jar: no models, blockstates,
items, sounds, or code. The client jar itself is downloaded to a temp
directory outside the repo and discarded; only the extracted textures are
written to `public/default-pack.zip`.

Every PNG is repacked byte-for-byte, unmodified: no resampling, re-encoding,
cropping, or other alteration. Regenerate with `npm run gen-pack` (Node 22+;
the script is run directly, relying on Node's TypeScript type stripping) and
commit the result — the output is deterministic (fixed entry order, fixed
mtime), so two runs against the same game version produce a byte-identical
zip and the committed file stays reviewable.

## Licence

The textures in `default-pack.zip` are Mojang's official vanilla Minecraft
block textures, copyright Mojang AB / Microsoft. They are bundled in this
repository at the repository owner's decision so the app looks textured out
of the box. They are **not** original work and **not** CC0 — unlike the
previous generated placeholder pack, these assets remain Mojang's property
and are used here under Mojang's usage guidelines for showing Minecraft
content, not redistributed as a general-purpose asset pack.
