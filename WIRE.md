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

`GET v1/scenes/:id/frame?after=<seq>` returns
`{sceneId,epoch,seq,capturedAt,reset,loadedChunks,totalChunks,entities,chunks,removedChunks:[]}`.
The actor array is authoritative: remove actors missing from the latest frame.
Actors contain `{id,kind,type,name,position:[x,y,z],yawDegrees,headYawDegrees,pitchDegrees,pose,scale,seated,skin:{url,model},equipment}`.
Kind is `player`, `npc`, `mob` or `display`; type is a Minecraft entity type.
Skin URLs are same-origin validated texture hashes. Equipped visible items may
contain material, amount, customModelData and tint; inventories/chat are absent.
Poll frames at 5 Hz; interpolate around 250 ms and stop extrapolating on stale
data. `epoch` changes on plugin restart. A scene switch or epoch change resets
the browser's chunk and actor state.

`chunks` lists `{x,z,revision,url}` for currently captured loaded chunks. Each
URL is revision-specific and includes `?epoch=<epoch>`; the query is required.
A missing/retired epoch or retired revision returns 410, never different bytes
under an immutable URL. Fetch only new revisions. A chunk body is
`{x,z,minY,height,palette:[blockstateStrings],runs:[count,paletteIndex,...]}`.
Iteration is Y outermost, then Z, then X fastest, exactly `256*height` cells.
Values outside the scene's X/Z bounds are air. Resolve blockstate descriptors
through exact Minecraft data, never Bukkit enum ordinals. Rebase terrain cells
to Y=0 in Prismarine and offset terrain root by `minY`; actors stay absolute.

Snapshots are captured in one aggregate Main budget. Conversion, palette/RLE,
compression, filesystem/HTTP and rendering run away from the gameplay thread.
Only already-loaded chunks are sampled; an unloaded chunk is explicit missing
coverage, not silently loaded/generated. Frames/caches/queues and public region
sizes are bounded. HTTP only selects configured/discovered locations, not
arbitrary world names, coordinates, files or commands.
