# tools

`gen-default-pack.ts` generates `public/default-pack.zip`, the resource pack the
app loads on startup so a build renders textured with no Minecraft installation
and no user action. Regenerate it with `npm run gen-pack` (Node 22+; the script
is run directly, relying on Node's TypeScript type stripping) and commit the
result — the output is deterministic, so two runs produce a byte-identical zip
and the committed file stays reviewable. `npm run gen-pack -- --sheet out.png`
additionally writes a contact sheet of every tile plus 3x3 tiling proofs.

## Licence

Every texture in `default-pack.zip` is original work: the pixels are computed
from the noise and shape functions in `gen-default-pack.ts`, and nothing is
copied, traced, or otherwise derived from Mojang's assets or from any other
resource pack. The generator and the generated pack are released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain).
