# ArcWorldView wire protocol 1

The plugin serves a read-only browser application at `/`; the production site
embeds it at `/worldview/` using a loopback TLS proxy. Every browser URL is
relative to that base. No Minecraft login, bot or world mutation is involved.

All bounds are half-open: minimum inclusive, maximum exclusive. Scene height is
at most 256 blocks; a location declares that vertical observation window. Chunk
coordinates in descriptors are chunk indices. Dynamic actors use absolute world
coordinates and Minecraft yaw/pitch degrees. Window height is a multiple of 16,
with height 16–256; the real-world `minY` may be any integer. An actor outside a configured
scene is not published. Default-hidden entities and invisible/vanished/spectator
players are not exposed.

`GET v1/scenes` returns:
`{schemaVersion:1,minecraftVersion:"1.21.11",assetRevision,assetsUrl,scenes:[{id,name,kind,world,bounds:{minX,minY,minZ,maxX,maxY,maxZ},camera:{target:[x,y,z],azimuthDegrees:45,elevationDegrees:35.264,spanBlocks},status}]}`.
`assetsUrl` points to `assets/<revision>/manifest.json`; manifest references are
relative to its own URL. Generated vanilla/server-pack assets stay outside Git.

`GET v1/scenes/:id/frame?after=<seq>&viewer=<UUID>&view=<minX,minZ,maxX,maxZ>` returns
`{sceneId,epoch,seq,capturedAt,reset,view,terrainComplete:false,loadedChunks,totalChunks,entities,chunks,removedChunks:[]}`.
`view` is an integer half-open camera footprint, clipped to the configured scene;
empty intersections and invalid parameters return 400. The browser includes a
conservative one-chunk context ring and the complete vertical window. Omitted
view parameters retain the legacy whole-scene behavior. Each anonymous viewer
has one current footprint, expiring after 15 seconds; at most sixteen live
footprints per scene are admitted. The site coordinator uses one stable upstream
viewer per scene and aggregates its browser interests.

Filtering occurs on the Minecraft host before JSON, gzip and transfer to the
site. Both counts refer to accepted view coverage. Actor arrays are authoritative
within that view. An absent terrain descriptor outside it is not an unload;
clients retain that cached context. With `terrainComplete:false`, absence inside
the view can also mean an unloaded chunk or RAM-cache eviction; last-known
terrain is retained. Explicit removals remain authoritative, and real world
clearance arrives as a new all-air chunk revision. Legacy frames without the
flag retain authoritative omission inside the view. A changed view is applied even if
the sequence is unchanged. Eligible scenes rotate fairly through two capture
lanes rather than letting the most recent two request streams starve others.
Actors contain `{id,kind,type,name,position:[x,y,z],yawDegrees,headYawDegrees,pitchDegrees,pose,scale,seated,skin:{url,model},equipment}`.
Kind is `player`, `npc`, `mob` or `display`; type is a Minecraft entity type.
An optional `sampledAt` epoch-millisecond value records when that actor's
appearance and position were captured on the server. Cached native observations
retain the same timestamp across scene frames; a new capture advances it even
when the actor is stationary. Packet-source observations use the frame capture
time. Old clients may ignore this field; new clients use `capturedAt` when it is
absent. This is sampling metadata, not a player or inventory identifier.
Display records retain native billboard, SRT and item context. A text display
keeps the plain `display.text` fallback and may additionally contain
`display.textStyle:{lineWidth,alignment,backgroundColor,defaultBackground,opacity,shadow,seeThrough,runs}`.
Background color is packed ARGB, opacity is unsigned 0–255, and alignment is
`LEFT`, `CENTER` or `RIGHT`. Runs contain `{text,color,font,bold,italic,underlined,strikethrough,obfuscated}`;
color is RGB and font is a resource key. Capture retains at most 256 codepoints,
512 component nodes and 64 inherited-style runs. Excessive style fragmentation
omits runs and keeps the bounded plain fallback. Hover/click events are never
transferred. Clients draw text as text, never HTML. Old clients may ignore this
optional style object. A new client uses native defaults for old frames.
Public packet displays use the same `kind:display` actor payload, with stable
owner IDs. They enter only through an explicitly registered public scene source;
packet display registries and per-player previews are never enumerated. The
common display fields retain `blockLight`, `skyLight`, `viewRange`,
`shadowRadius` and `shadowStrength` in addition to billboard and SRT.
An item display may contain `animation:{capturedAt,capturedFrame,sampleMillis,items,samples,itemSwitches}`.
`capturedAt` is the server epoch in milliseconds, `sampleMillis` is the fixed
spacing, and each sample contains world `position`, `yawDegrees`, `pitchDegrees`,
native SRT and a discrete `itemIndex` into the visible item palette. At most
21 samples, 8 palette items and 2000 ms are retained per display; each query
returns at most 128 displays. Up to 8 sorted `itemSwitches:{offsetMillis,itemIndex}`
retain exact discrete native reward changes separately from the pose cadence.
The owner computes these poses using its native
trajectory. A client interpolates locally with requestAnimationFrame, replaces
the forward window on refresh without restarting the phase, and freezes at the
last sample after expiry. A window is never looped. One canonical crate caption
is exported; private player-facing front/back packet copies are absent.
Skin URLs are same-origin validated texture hashes. Equipped visible items may
contain material, amount, customModelData and tint; inventories/chat are absent.
Poll frames at 5 Hz; buffer actor samples according to source cadence and jitter,
and hold the latest observed pose when the buffer runs out. `epoch` changes on
plugin restart. A scene switch or epoch change resets
the browser's chunk and actor state.

`chunks` lists `{x,z,revision,url}` for currently captured loaded chunks. Each
URL is revision-specific and includes `?epoch=<epoch>`; the query is required.
A missing/retired epoch or retired revision returns 410, never different bytes
under an immutable URL. Fetch only new revisions. A chunk body is
`{x,z,minY,height,palette:[blockstateStrings],runs:[count,paletteIndex,...],occludedBlocks,occlusionEncoding:"opaque-fill"}`.
Iteration is Y outermost, then Z, then X fastest, exactly `256*height` cells.
Values outside the scene's X/Z bounds are air. Resolve blockstate descriptors
through exact Minecraft data, never Bukkit enum ordinals. Rebase terrain cells
to Y=0 in Prismarine and offset terrain root by `minY`; actors stay absolute.

Interior culling also happens before transfer. A full opaque cell enclosed by
six full opaque neighbours is replaced by a generic opaque `minecraft:stone`
fill, not air, so client meshing still rejects internal faces. Published palettes
omit hidden original identities. All decisions use the original occupancy;
unknown neighbours at chunk/window boundaries are retained. Glass, non-full
shapes and non-occluding states do not seal a cell. Exposing a neighbour causes
normal recapture/revision publication to restore the real visible material.

`GET v1/scenes/:scene/entities/:id` returns
`{id,kind,title,fields:[{key,label,value}],capturedAt}`. Only a currently public
actor in that scene's detached snapshot may be queried. The first request can
return 425 while one bounded Main-thread public-info capture is queued; removed
actors return 404 and bounded capacity returns 429. Existing actors without an
extra provider have an empty field list. Plain-text ArcCivs fields are opt-in
resident information, never inventory, cargo, membership or administrator data.
Clients refresh pinned visible details at most once per second and cancel an
obsolete scene/entity selection.

The website application additionally provides
`GET v1/scenes/:scene/terrain?view=<minX,minZ,maxX,maxZ>` with
`{sceneId,epoch,capturedAt,stale,view,chunks,loadedChunks,totalChunks}`.
It contains persistent terrain descriptors, no entities. Before any live frame,
saved terrain may establish an explicitly stale initial epoch. Once a live
frame has arrived, late cache responses cannot override its epoch, revisions or
authoritative missing chunks. Live entity frames remain memory-only in the site
coordinator, with one shared upstream refresh loop per scene, independent of the
number of browsers. HTTP transport heartbeat and snapshot freshness are separate.

Snapshots are captured in one aggregate Main budget. Conversion, palette/RLE,
compression, filesystem/HTTP and rendering run away from the gameplay thread.
Only already-loaded chunks are sampled; an unloaded chunk is explicit missing
coverage, not silently loaded/generated. Frames/caches/queues and public region
sizes are bounded. HTTP only selects configured/discovered locations, not
arbitrary world names, coordinates, files or commands.
