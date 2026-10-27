# ArcWorldView browser

The standalone viewer is bundled in the plugin JAR. The website `/world` route
embeds that same application at `/worldview/`. All API and worker URLs resolve
relative to the application; all asset references resolve relative to the
catalog's asset manifest. There is no Minecraft login or Mineflayer session.

## Build

Use Node 24. The required project-owned renderer helpers are bundled in
`vendor/renderer`, with source provenance pinned by `../renderer-source.ref`.
The public build uses these checked inputs directly and needs no credentials
or operations-repository checkout.

```sh
npm ci
npm run build
npm test
```

The build emits `dist/` with static HTML, CSS, the application, two worker
bundles, locally hosted Golos fonts and full `THIRD_PARTY_NOTICES.txt` assembled
from actual esbuild inputs. Gradle packages this directory under `web/`.
The build and unit tests do not need Minecraft or server-pack binaries.
Pinned canvas 3.2.3 supports prebuilt Linux x86_64 glibc binaries; source builds
instead require its documented Cairo/Pango build dependencies.

Shared owned helpers provide player geometry/skins/poses, item geometry, colour
configuration, and the existing stairs-model correction. Stock
prismarine-viewer 1.33.0 and Three 0.128.0 remain unmodified dependencies.
The browser NBT boundary extracts pinned upstream pure JSON-tree helpers during
the build, preserving their semantics and license. Binary NBT parsing/writing is
explicitly unsupported: the viewer receives validated JSON/RLE snapshots and
does not load Minecraft protocol compilers. This keeps both workers compatible
with `script-src 'self'` without `unsafe-eval`. Tests run the actual built worker
bundles with string code generation disabled, so build before running tests.

## Private runtime assets

```sh
npm run assets -- --client-jar /private/minecraft-1.21.11-client.jar \
  --resource-pack /private/extracted-server-resource-pack
```

Omit `--client-jar` to download and verify the pinned official client. Omit
`--resource-pack` for vanilla. `--output` chooses an alternate private output
directory. The default is ignored `.assets/`; never add this directory, the
client JAR, extracted resources, or generated texture/model binaries to Git.

The generator merges vanilla resources with pack-format 75 overlays, compiles
real block geometry and item/CMD/display-context models, and retains only
runtime dependencies. `current.json` selects a content revision;
`<revision>/manifest.json` contains URL references and a file allowlist with
SHA-256, length and MIME type. Copy `current.json` and the **whole revision
directory** into `plugins/ArcWorldView/assets/` using the normal authorized
deployment workflow. Generation itself changes no server state.

The vanilla client checksum is
`ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd`. Minecraft and server-pack artwork is
generated privately from those inputs and is not part of the source repository.
Bitmap labels use the corresponding native Minecraft font atlas. The browser
interface uses Golos; its OFL is included with the browser notices.

## Capture/render contract

See [WIRE.md](../WIRE.md). Bounds are half-open, chunk X/Z are grid indices,
and each explicit height window is 16–256 cells in multiples of 16. Real-world
`minY` may be any integer. The adapter rebases terrain cells to Y=0 and offsets
the terrain root; it never silently clips the full world height to 256.

Frames are authoritative for actors and current chunk descriptors. The browser
polls at 5 Hz, interpolates positions/yaw 250 ms behind the latest frames, stops
motion when updates stop, and only fetches changed chunk revisions. Chunk
decoding and meshing run in workers, with at most two chunk fetches in flight.
Switching location or epoch clears stale state; catalog refresh also handles
new bounds and asset revisions. Hidden tabs stop polling/rendering.

## Model coverage

Terrain uses the selected Minecraft block states and server-pack models, with
16 px sprites surrounded by repeated edge texels in the generated atlas. This
keeps antialiased polygon edges from sampling an adjacent sprite. Ordinary structures, stairs, foliage and IA
block geometry are data driven. Supplemental closed chest models (single,
double, trapped and ender), all bed colours, and standing/wall signs use native
client part dimensions and original entity texture regions. The current
snapshot does not carry chest lid animation or sign text.

Players/NPCs use native skins, slim/default arms and outer layers; ordinary
humanoid armour, held items and head items follow the skeleton. Supported mobs
use real skeletons/textures, with locomotion driven by observed movement.
The adapter preserves baked rest geometry, uses each native joint once, and
moves complete limb chains. Java 1.21.11 UV layouts and the current horse model
are explicit compatibility data; texture image dimensions do not define the UV
space, so HD textures keep their intended normalized coordinates. See
[MODEL_COMPATIBILITY.md](MODEL_COMPATIBILITY.md) for the pinned source evidence
and regression boundary. This is a bounded walking pose, not the complete
Minecraft animation state machine.
ItemDisplay supports native model/CMD/context and display transforms;
BlockDisplay uses the same worker mesher as terrain; plain TextDisplay uses
native bitmap glyphs. Unsupported models are omitted with a visible coverage
notice, never replaced by coloured cubes.

`coverage.json` lists remaining special item renderers, entity incompatibilities and blocks outside the
stock/supplemental renderer. Examples include banners, shulker boxes, hanging
signs and animated compass/clock item renderers. Newer mob types outside the
bundled skeleton set are also explicit missing coverage. Biome tint currently
uses plains, and time/weather lighting is presentation lighting; the wire does
not yet carry per-cell biome/light or weather data.

## Local representative fixture

After building and generating assets:

```sh
WEBSITE_DIST=/path/to/ruscrafting-website/dist npm run fixture
```

Open `http://127.0.0.1:3094/` for the standalone app, or `/world` for the real
website shell and same-origin iframe. `PORT` and `ARC_WORLDVIEW_ASSETS` are
optional. The fixture is clearly labelled as a synthetic village. It includes
walking players/NPCs/animals, equipment, real IA display models when present,
and chest/bed/sign examples. Its second location has brick roofs, making stale
terrain after a scene switch observable. It sends the production CSP and nosniff
headers. It is never bundled into the plugin. The fixture captures its asset
revision on startup; restart it after asset regeneration.
Inspection locations provide close views of animals, full player armour,
chests, a bed, a fence corner and a wall. The animal row alternates ten seconds
of movement and six seconds at rest, so the transition can be checked as well
as a still pose.

A fixture render verifies the browser and model pipeline. It does not prove
production capture, main-thread load, live ArcCivs visibility or nginx delivery.
