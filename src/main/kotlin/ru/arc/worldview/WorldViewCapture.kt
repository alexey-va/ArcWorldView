package ru.arc.worldview

import org.bukkit.Bukkit
import org.bukkit.World
import org.bukkit.entity.Entity
import org.bukkit.event.EventHandler
import org.bukkit.event.EventPriority
import org.bukkit.event.HandlerList
import org.bukkit.event.Listener
import org.bukkit.event.block.BlockBreakEvent
import org.bukkit.event.block.BlockBurnEvent
import org.bukkit.event.block.BlockFadeEvent
import org.bukkit.event.block.BlockFormEvent
import org.bukkit.event.block.BlockGrowEvent
import org.bukkit.event.block.BlockPlaceEvent
import org.bukkit.event.block.BlockSpreadEvent
import org.bukkit.event.entity.EntityExplodeEvent
import org.bukkit.event.entity.EntitySpawnEvent
import org.bukkit.event.player.PlayerJoinEvent
import org.bukkit.event.player.PlayerQuitEvent
import org.bukkit.event.world.ChunkLoadEvent
import org.bukkit.event.world.ChunkUnloadEvent
import org.bukkit.event.world.EntitiesLoadEvent
import org.bukkit.event.world.EntitiesUnloadEvent
import org.bukkit.event.world.WorldUnloadEvent
import org.bukkit.plugin.java.JavaPlugin
import ru.arc.core.BoundedAsyncExecutor
import ru.arc.core.ScheduledTask
import ru.arc.observability.RuntimeHealthContribution
import ru.arc.observability.RuntimeHealthState
import ru.arc.paper.api.ArcSceneBounds
import ru.arc.paper.api.ArcSceneObservationService
import ru.arc.paper.api.ArcSceneEntityInfoService
import ru.arc.paper.runtime.PaperPluginRuntime
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.logging.Level
import java.util.function.LongSupplier
import kotlin.math.floor
import kotlin.math.min

/**
 * One aggregate Main capture budget. ChunkSnapshot conversion, actor profile decoding, JSON and
 * gzip belong to the supplied worker. No chunk is loaded, generated or retained by this owner.
 * A native snapshot copy and Chunk.getEntities() are indivisible calls: the time budget is checked
 * between calls and cannot preempt either. At most one of each is admitted per tick.
 */
class WorldViewCapture(
    private val plugin: JavaPlugin,
    private val runtime: PaperPluginRuntime,
    private val settings: WorldViewSettings,
    private val observer: ArcSceneObservationService,
    private val worker: BoundedAsyncExecutor,
    private val assets: WorldViewAssets,
    private val model: WorldViewReadModel,
    private val entityInformation: ArcSceneEntityInfoService? = null,
) : AutoCloseable, Listener {
    private var nanoTime = LongSupplier(System::nanoTime)
    internal constructor(plugin: JavaPlugin, runtime: PaperPluginRuntime, settings: WorldViewSettings,
        observer: ArcSceneObservationService, worker: BoundedAsyncExecutor, assets: WorldViewAssets,
        model: WorldViewReadModel, nanoTime: LongSupplier) : this(plugin, runtime, settings, observer, worker, assets, model) {
        this.nanoTime = nanoTime
    }
    private class Fence { val active = AtomicBoolean(true); val frame = AtomicLong() }
    private class Scene(val worldId: UUID?, val published: PublishedScene) {
        val fence = Fence()
        val slots = published.definition.bounds.chunks().associateWithTo(linkedMapOf()) { CaptureChunkState() }
        val urgent = linkedSetOf<ChunkKey>()
        val hot = linkedSetOf<ChunkKey>()
        var chunkCursor = 0
        var discoveryCursor = 0
        var playerCursor = 0
        var frameAt = 0L
        val framePending = AtomicBoolean()
        var informationAt = 0L
        val informationPending = AtomicBoolean()
    }
    private data class NativeActor(val entity: Entity, var worldId: UUID, var captured: CapturedActor? = null, var at: Long = 0L)
    private data class ChunkResult(val sceneId: String, val fence: Fence, val key: ChunkKey,
        val ticket: Long, val capturedAt: Long, val encoded: EncodedChunk?, val failure: Throwable?)
    private data class CacheKey(val scene: String, val chunk: ChunkKey)
    private data class Cached(val owner: PublishedScene, val chunk: PublishedChunk)

    private val token = runtime.tasks.token()
    private val closed = AtomicBoolean()
    private val ready = CompletableFuture<Unit>()
    private val pending = AtomicInteger()
    private val maximumPending = settings.workerThreads + settings.workerQueue
    private val results = ConcurrentLinkedQueue<ChunkResult>()
    private val errors = ArrayBlockingQueue<Throwable>(maximumPending)
    private val scenes = linkedMapOf<String, Scene>()
    private val nativeActors = linkedMapOf<UUID, NativeActor>()
    private val entityHints = ArrayDeque<Entity>()
    private val retiredEntityHints = ArrayDeque<Entity>()
    // Only detached reference publication is protected here; JSON/native work never holds this lock.
    private val publication = Any()
    private val cache = LinkedHashMap<CacheKey, Cached>(16, .75f, true)
    private val catalogVersion = AtomicLong()
    private val catalogPending = AtomicBoolean()
    private val healthPending = AtomicBoolean()
    private val sequence = AtomicLong()
    private val publishedCatalog = AtomicBoolean()
    private var catalogDirty = true
    private var catalogAt = 0L
    private var healthAt = 0L
    private var tick = 0L
    private val chunkLane = CaptureSceneLane()
    private val playerLane = CaptureSceneLane()
    private val entityLane = CaptureSceneLane()
    private val discoveryOffsets = hashMapOf<Pair<UUID, ChunkKey>, Int>()
    private var revision = 0L
    private var cachedBytes = 0L
    private var listener: AutoCloseable? = null
    private var timer: ScheduledTask? = null
    private var started = false
    private var warnedAt = 0L
    private var suppressed = 0
    @Volatile private var failed = false
    @Volatile private var contribution = RuntimeHealthContribution(state = RuntimeHealthState.STARTING)

    /** Completes after the first detached catalog is published; no viewer is required. */
    fun start(): CompletableFuture<Unit> {
        checkMain()
        check(!closed.get()) { "World-view capture is closed" }
        if (started) return ready.copy()
        started = true
        try {
            listener = observer.registerChunkListener(plugin, "world-view") { world, x, z -> dirty(world, ChunkKey(x, z)) }
            plugin.server.pluginManager.registerEvents(this, plugin)
            refreshCatalog(System.currentTimeMillis())
            publishCatalog()
            timer = runtime.tasks.runTimer(token, 1, 1, ::captureTick)
            check(timer != null) { "World-view capture lifecycle is inactive" }
        } catch (failure: Throwable) {
            ready.completeExceptionally(failure)
            close()
            throw failure
        }
        return ready.copy()
    }

    /** Cached values only; safe for health probes on any thread. */
    fun health(): RuntimeHealthContribution = contribution

    private fun captureTick() {
        checkMain()
        if (!current()) return
        val now = System.currentTimeMillis()
        val budget = CaptureTickBudget(nanoTime.asLong, settings.budgetNanos, settings.chunksPerTick, settings.entitySamples)
        tick++
        try {
            applyResults(budget)
            errors.poll()?.let { warn(now, it) }
            if (now >= catalogAt && budget.hasTime(nanoTime.asLong)) refreshCatalog(now)
            if (catalogDirty) publishCatalog()
            val access = scenes.mapValues { it.value.published.lastAccess.get() }
            val eligible = captureActiveScenes(access, now, settings.idleMillis, scenes.size)
            chunkLane.retain(eligible); playerLane.retain(eligible); entityLane.retain(eligible)
            val active = captureActiveScenes(access, now, settings.idleMillis,
                min(settings.activeScenes, 2), tick).mapNotNull { scenes[it] }
            val activeWorlds = active.mapNotNullTo(hashSetOf()) { it.worldId }
            val retainedWorlds = eligible.mapNotNullTo(hashSetOf()) { scenes[it]?.worldId }
            nativeActors.entries.removeIf { it.value.worldId !in retainedWorlds }
            if (active.isNotEmpty()) {
                // Frames consume detached cached actors first. Alternate native lane priority so
                // expensive actor captures cannot starve terrain, or a snapshot starve actors.
                captureFrames(active, budget, now)
                captureInformation(active, budget, now)
                discoverHints(activeWorlds, budget)
                discoverPlayers(active, budget)
                if (tick % 2L == 0L) captureChunks(active, budget, now)
                if (tick % 2L != 0L) discoverEntities(active, budget)
                refreshActors(active, budget, now)
                if (tick % 2L != 0L) captureChunks(active, budget, now)
            } else { entityHints.clear(); retiredEntityHints.clear() }
            contribution = RuntimeHealthContribution(
                state = when { !publishedCatalog.get() -> RuntimeHealthState.STARTING; failed -> RuntimeHealthState.DEGRADED; else -> RuntimeHealthState.UP },
                recoveryBacklog = pending.get(), activeLeases = active.size,
                schemas = mapOf("wire" to 1), dependencies = mapOf("catalog" to publishedCatalog.get(), "observer" to true),
            )
            if (now >= healthAt) publishHealth(now, active.size)
        } catch (failure: Throwable) { warn(now, failure) }
    }

    private fun refreshCatalog(now: Long) {
        val definitions = linkedMapOf<String, Pair<UUID?, ViewerScene>>()
        for (location in settings.fixedLocations.take(32)) {
            val world = plugin.server.getWorld(location.world)
            definitions[location.id] = world?.uid to definition(location.id, location.name, location.kind,
                world?.name ?: location.world, location.center, location.radius, world != null)
        }
        if (settings.discoverSettlements && definitions.size < 32) {
            for (location in observer.locations(32)) {
                if (definitions.size == 32) break
                if (!SCENE_ID.matches(location.id) || location.id in definitions) continue
                val world = plugin.server.getWorld(location.worldId)
                definitions[location.id] = location.worldId to definition(location.id, location.name, "settlement",
                    world?.name ?: location.worldId.toString(), listOf(location.x, location.y, location.z),
                    floor(location.radius).toInt().coerceIn(1, settings.maxRadius), world != null)
            }
        }
        var changed = false
        for (id in scenes.keys.toList()) if (id !in definitions) { retire(id); changed = true }
        for ((id, value) in definitions) {
            val (world, definition) = value
            val previous = scenes[id]
            if (previous != null && (previous.worldId != world || previous.published.definition.bounds != definition.bounds)) retire(id)
            val state = scenes[id] ?: Scene(world, PublishedScene(definition)).also {
                scenes[id] = it; model.scenes[id] = it.published; changed = true
            }
            if (state.published.definition != definition) { state.published.definition = definition; changed = true }
        }
        if (changed || !publishedCatalog.get()) { catalogVersion.incrementAndGet(); catalogDirty = true }
        catalogAt = now + 2_000
    }

    private fun definition(id: String, name: String, kind: String, world: String,
        center: List<Double>, radius: Int, available: Boolean): ViewerScene {
        val r = radius.coerceIn(1, min(settings.maxRadius, 128))
        val x = floor(center[0]).toInt(); val z = floor(center[2]).toInt()
        val bounds = SceneBounds(x - r, settings.minY, z - r, x + r, settings.maxY, z + r)
        return ViewerScene(id, name, kind, world, bounds,
            SceneCamera(center.toList(), 45.0, 35.264, r * 2.0), if (available) "ready" else "world-unavailable")
    }

    private fun publishCatalog() {
        if (!catalogDirty || !catalogPending.compareAndSet(false, true)) return
        val version = catalogVersion.get()
        val catalog = SceneCatalog(1, "1.21.11", assets.revision, "assets/${assets.revision}/manifest.json",
            scenes.values.map { it.published.definition })
        if (submit {
                try {
                    val payload = WirePayload.json(catalog)
                    val accepted = synchronized(publication) {
                        if (current() && catalogVersion.get() == version) {
                            model.catalog = payload; model.ready = true; publishedCatalog.set(true); failed = false; true
                        } else false
                    }
                    if (accepted) ready.complete(Unit)
                } finally { catalogPending.set(false) }
            }) catalogDirty = false else catalogPending.set(false)
    }

    private fun discoverPlayers(active: List<Scene>, budget: CaptureTickBudget) {
        for (id in playerLane.order(active.map { it.published.definition.id })) {
            if (!budget.hasTime(nanoTime.asLong)) return
            val state = scenes[id] ?: continue
            playerLane.attempted(id)
            val world = state.worldId?.let(plugin.server::getWorld) ?: continue
            val players = world.players
            if (players.isEmpty()) continue
            repeat(min(players.size, min(16, (min(settings.entitySamples, 96) / 8).coerceAtLeast(1)))) {
                if (!budget.claimEntity(nanoTime.asLong)) return
                remember(players[Math.floorMod(state.playerCursor++, players.size)], world.uid)
            }
            return
        }
    }

    private fun discoverHints(activeWorlds: Set<UUID>, budget: CaptureTickBudget) {
        repeat(min(retiredEntityHints.size, 8)) {
            if (!budget.claimEntity(nanoTime.asLong)) return
            nativeActors.remove(retiredEntityHints.removeFirst().uniqueId)
        }
        repeat(min(entityHints.size, (min(settings.entitySamples, 96) / 8).coerceAtLeast(1))) {
            if (!budget.claimEntity(nanoTime.asLong)) return
            val entity = entityHints.removeFirst()
            if (entity.isValid) entity.world.uid.takeIf { it in activeWorlds }?.let { remember(entity, it) }
        }
    }

    private fun remember(entity: Entity, world: UUID) {
        val id = entity.uniqueId
        nativeActors[id]?.takeIf { it.worldId != world }?.let { it.worldId = world; it.captured = null; it.at = 0 }
        if (id !in nativeActors) {
            if (nativeActors.size >= min(settings.entityLimit * 2, 1024)) nativeActors.remove(nativeActors.keys.first())
            nativeActors[id] = NativeActor(entity, world)
        }
    }

    private fun refreshActors(active: List<Scene>, budget: CaptureTickBudget, now: Long) {
        val worlds = active.mapNotNullTo(hashSetOf()) { it.worldId }
        val candidates = nativeActors.entries.filter { it.value.worldId in worlds }.map { it.key to it.value }
        for ((id, known) in candidates) {
            // Reserve a short discovery lane so a full actor cache cannot starve newly loaded mobs.
            val reserve = min(16, min(settings.entitySamples, 96) / 4)
            if (budget.entityCount >= min(settings.entitySamples, 96) - reserve || !budget.claimEntity(nanoTime.asLong)) return
            if (nativeActors[id] !== known) continue
            nativeActors.remove(id)
            val entity = known.entity
            if (!entity.isValid || entity.isDead) continue
            val world = entity.world.uid
            if (known.worldId != world) { known.worldId = world; known.captured = null; known.at = 0 }
            val actor = ActorWire.native(entity) ?: continue
            val owners = active.filter { it.worldId == world && it.published.definition.bounds.contains(actor.position[0], actor.position[1], actor.position[2]) }
            if (owners.isEmpty()) { nativeActors[id] = known; continue }
            known.worldId = world; known.captured = actor; known.at = now
            nativeActors[id] = known
            val key = ChunkKey(floor(actor.position[0]).toInt() shr 4, floor(actor.position[2]).toInt() shr 4)
            for (owner in owners) {
                owner.hot.remove(key); owner.hot.add(key)
                if (owner.hot.size > 32) owner.hot.remove(owner.hot.first())
            }
        }
    }

    private fun discoverEntities(active: List<Scene>, budget: CaptureTickBudget) {
        if (!budget.hasTime(nanoTime.asLong) || budget.entityCount >= min(settings.entitySamples, 96)) return
        val id = entityLane.order(active.map { it.published.definition.id }).firstOrNull() ?: return
        val owner = scenes[id] ?: return
        entityLane.attempted(id)
        val world = owner.worldId?.let(plugin.server::getWorld) ?: return
        val requested = owner.published.requestedViews(System.currentTimeMillis())
        val keys = owner.slots.keys.filter { key -> requested.any { it.intersects(key) } }
        repeat(keys.size) {
            if (!budget.hasTime(nanoTime.asLong)) return
            val key = keys[Math.floorMod(owner.discoveryCursor++, keys.size)]
            if (!world.isChunkLoaded(key.x, key.z)) return@repeat
            val chunk = world.getChunkAt(key.x, key.z)
            if (!chunk.isEntitiesLoaded) return
            // Paper exposes an array only: one indivisible native enumeration, never a world scan.
            val entities = chunk.entities
            if (entities.isEmpty()) return
            val identity = world.uid to key
            var offset = discoveryOffsets[identity] ?: 0
            val discoveryQuota = (min(settings.entitySamples, 96) / 4).coerceIn(1, 16)
            repeat(min(entities.size, discoveryQuota)) {
                if (!budget.claimEntity(nanoTime.asLong)) { discoveryOffsets[identity] = offset; return }
                remember(entities[Math.floorMod(offset++, entities.size)], world.uid)
            }
            discoveryOffsets[identity] = offset
            return
        }
    }

    private fun captureFrames(active: List<Scene>, budget: CaptureTickBudget, now: Long) {
        for (owner in active) {
            if (owner.framePending.get() || tick < owner.frameAt || !budget.hasTime(nanoTime.asLong) || !capacity()) continue
            val world = owner.worldId ?: continue
            val definition = owner.published.definition
            val b = owner.published.captureBounds(now)
            val bounds = ArcSceneBounds(world, b.minX.toDouble(), b.minY.toDouble(), b.minZ.toDouble(),
                b.maxX.toDouble(), b.maxY.toDouble(), b.maxZ.toDouble())
            val observed = observer.entities(bounds, settings.entityLimit).map(ActorWire::observed)
            val displays = observer.displays(bounds, min(settings.entityLimit, 128)).map(ActorWire::observedDisplay)
            val actors = (observed + displays + nativeActors.values.asSequence().filter { it.worldId == world && now - it.at <= 2_000 }
                .mapNotNull { it.captured }.filter { b.contains(it.position[0], it.position[1], it.position[2]) }.toList())
                .distinctBy { it.id }.take(settings.entityLimit)
            for (actor in observed) {
                val key = ChunkKey(floor(actor.position[0]).toInt() shr 4, floor(actor.position[2]).toInt() shr 4)
                owner.hot.remove(key); owner.hot.add(key)
                if (owner.hot.size > 32) owner.hot.remove(owner.hot.first())
            }
            val descriptors = owner.published.chunks.entries.sortedWith(compareBy({ it.key.z }, { it.key.x })).map { (key, value) ->
                ChunkDescriptor(key.x, key.z, value.revision, captureChunkUrl(definition.id, key, value.revision, model.epoch))
            }
            // Missing snapshots can be unloaded chunks or RAM-cache eviction, never proof
            // of deleted world geometry. Real clearance is a new all-air chunk revision.
            val removed = emptyList<ChunkKey>()
            val seq = sequence.incrementAndGet()
            val fence = owner.fence
            fence.frame.set(seq)
            owner.framePending.set(true)
            val publication = owner.published
            val total = owner.slots.size
            val reset = publication.frame == null
            if (submit {
                    try {
                        val frame = SceneFrame(definition.id, model.epoch, seq, now, reset, descriptors.size, total,
                            actors.map { ActorWire.wire(it, assets::allowSkinHash) }, descriptors, removed)
                        val payload = WirePayload.json(frame)
                        synchronized(this.publication) {
                            if (current() && fence.active.get() && fence.frame.get() == seq && model.scenes[definition.id] === publication) {
                                publication.snapshot = frame
                                publication.frame = payload; failed = false
                            }
                        }
                    } finally { owner.framePending.set(false) }
                }) {
                owner.frameAt = tick + 4
            } else owner.framePending.set(false)
        }
    }

    private fun captureChunks(active: List<Scene>, budget: CaptureTickBudget, now: Long) {
        if (!capacity() || !budget.hasTime(nanoTime.asLong)) return
        for (id in chunkLane.order(active.map { it.published.definition.id })) {
            if (!budget.hasTime(nanoTime.asLong) || !capacity()) return
            val owner = scenes[id] ?: continue
            chunkLane.attempted(id)
            val world = owner.worldId?.let(plugin.server::getWorld) ?: continue
            val requested = owner.published.requestedViews(now)
            val needed = owner.slots.keys.filter { key -> requested.any { it.intersects(key) } }
            // A cold viewport starts at its centre rather than sweeping rows from the scene edge.
            val missing = needed.filter { !owner.published.chunks.containsKey(it) }.sortedBy { key ->
                requested.minOf { view ->
                    val x = key.x * 16.0 + 8 - (view.minX.toDouble() + view.maxX) / 2
                    val z = key.z * 16.0 + 8 - (view.minZ.toDouble() + view.maxZ) / 2
                    x * x + z * z
                }
            }
            val hotDue = owner.hot.filter { now - (owner.slots[it]?.capturedAt ?: 0L) >= min(settings.refreshMillis, 1_000) }.toSet()
            val ordered = (missing + owner.urgent + hotDue + rotate(needed, owner.chunkCursor++))
                .distinct().filter { key -> requested.any { it.intersects(key) } }
            for (key in ordered) {
                if (!budget.hasTime(nanoTime.asLong) || !capacity()) return
                val slot = owner.slots.getValue(key)
                if (slot.inFlight || now - slot.attemptedAt < 250 || !slot.dirty && key !in hotDue && now - slot.capturedAt < settings.refreshMillis) continue
                slot.attemptedAt = now
                if (!world.isChunkLoaded(key.x, key.z)) { removeChunk(owner, key); continue }
                if (!budget.claimChunk(nanoTime.asLong)) return
                val snapshot = world.getChunkAt(key.x, key.z).getChunkSnapshot(false, false, false, false)
                val ticket = slot.begin()
                owner.urgent.remove(key)
                val id = owner.published.definition.id; val bounds = owner.published.definition.bounds
                val minimum = world.minHeight; val maximum = world.maxHeight; val fence = owner.fence
                if (!submit {
                        try {
                            val encoded = ChunkEncoder.encode(snapshot, key, bounds, minimum, maximum)
                            if (current() && fence.active.get()) results.add(ChunkResult(id, fence, key, ticket, now, encoded, null))
                        } catch (failure: Throwable) {
                            if (current() && fence.active.get()) results.add(ChunkResult(id, fence, key, ticket, now, null, failure))
                        }
                    }) slot.failed()
                return
            }
        }
    }

    private fun captureInformation(active: List<Scene>, budget: CaptureTickBudget, now: Long) {
        for (owner in active) {
            if (now < owner.informationAt || owner.informationPending.get() ||
                !budget.hasTime(nanoTime.asLong) || !capacity()) continue
            val world = owner.worldId ?: continue
            val requests = owner.published.informationRequests(now)
            if (requests.isEmpty()) continue
            owner.informationAt = now + 1_000
            val bounds = owner.published.captureBounds(now)
            val ids = requests.mapTo(linkedSetOf()) { it.id }
            val values = entityInformation?.information(ArcSceneBounds(world,
                bounds.minX.toDouble(), bounds.minY.toDouble(), bounds.minZ.toDouble(),
                bounds.maxX.toDouble(), bounds.maxY.toDouble(), bounds.maxZ.toDouble()), ids, 64)
                ?.associateBy { it.entityId }.orEmpty()
            val actors = owner.published.snapshot?.entities?.associateBy { it.id }.orEmpty()
            val detached = requests.mapNotNull { request ->
                val actor = actors[request.id] ?: return@mapNotNull null
                val info = values[request.id]
                request to ViewerEntityInfo(request.id, info?.kind ?: actor.kind, info?.title ?: actor.name,
                    info?.fields?.map { ViewerInfoField(it.key, it.label, it.value) }.orEmpty(), now)
            }
            owner.informationPending.set(true)
            if (!submit {
                    try {
                        val payloads = detached.map { (request, info) -> request to WirePayload.json(info) }
                        if (current() && owner.fence.active.get()) payloads.forEach { (request, payload) -> request.payload = payload }
                    } finally { owner.informationPending.set(false) }
                }) owner.informationPending.set(false)
            return // At most one bounded public-source query in the aggregate Main budget.
        }
    }

    private fun applyResults(budget: CaptureTickBudget) {
        while (budget.hasTime(nanoTime.asLong)) {
            val result = results.poll() ?: return
            val owner = scenes[result.sceneId]?.takeIf { it.fence === result.fence && it.fence.active.get() } ?: continue
            val slot = owner.slots[result.key] ?: continue
            if (result.failure != null) { slot.failed(); errors.offer(result.failure); continue }
            val payload = requireNotNull(result.encoded).payload
            val next = slot.accept(result.ticket, payload.etag) { ++revision } ?: continue
            slot.capturedAt = result.capturedAt
            if (payload.size > min(settings.cacheBytes, MAX_CACHE_BYTES)) continue
            val key = CacheKey(result.sceneId, result.key)
            val old = owner.published.chunks[result.key]
            val published = if (old?.revision == next) old else PublishedChunk(next, payload)
            cache.remove(key)?.let { cachedBytes -= it.chunk.payload.size }
            owner.published.chunks[result.key] = published
            cache[key] = Cached(owner.published, published); cachedBytes += published.payload.size
            while (cachedBytes > min(settings.cacheBytes, MAX_CACHE_BYTES)) {
                val entry = cache.entries.first()
                cache.remove(entry.key); cachedBytes -= entry.value.chunk.payload.size
                entry.value.owner.chunks.remove(entry.key.chunk, entry.value.chunk)
            }
        }
    }

    private fun dirty(world: UUID, key: ChunkKey) {
        checkMain()
        if (!current()) return
        for (owner in scenes.values) if (owner.worldId == world) owner.slots[key]?.let {
            it.changed(); owner.urgent.add(key)
        }
    }

    private fun removeChunk(owner: Scene, key: ChunkKey) {
        owner.slots[key]?.invalidate()
        owner.published.chunks.remove(key)
        cache.remove(CacheKey(owner.published.definition.id, key))?.let { cachedBytes -= it.chunk.payload.size }
    }

    private fun retire(id: String) {
        val owner = scenes.remove(id) ?: return
        owner.fence.active.set(false); owner.published.chunks.clear(); model.scenes.remove(id, owner.published)
        val iterator = cache.entries.iterator()
        while (iterator.hasNext()) { val value = iterator.next(); if (value.key.scene == id) { cachedBytes -= value.value.chunk.payload.size; iterator.remove() } }
        owner.worldId?.let { world -> discoveryOffsets.keys.removeIf { it.first == world } }
    }

    private fun publishHealth(now: Long, active: Int) {
        if (!healthPending.compareAndSet(false, true)) return
        val health = mapOf("schemaVersion" to 1, "state" to contribution.state.wireName, "ready" to publishedCatalog.get(),
            "scenes" to scenes.size, "activeScenes" to active, "chunkCacheBytes" to cachedBytes,
            "pendingWork" to pending.get(), "nativeActors" to nativeActors.size)
        if (submit {
                try { val payload = WirePayload.json(health); synchronized(publication) { if (current()) model.health = payload } }
                finally { healthPending.set(false) }
            }) healthAt = now + 1_000 else healthPending.set(false)
    }

    private fun capacity() = pending.get() + results.size < maximumPending
    private fun submit(operation: () -> Unit): Boolean {
        if (!current() || !capacity()) return false
        pending.incrementAndGet()
        return try {
            worker.execute {
                try { if (current()) operation() }
                catch (failure: Throwable) { failed = true; if (current()) errors.offer(failure) }
                finally { pending.decrementAndGet() }
            }
            true
        } catch (_: RejectedExecutionException) { pending.decrementAndGet(); false }
    }

    private fun current() = !closed.get() && runtime.tasks.isCurrent(token)
    private fun checkMain() { check(Bukkit.isPrimaryThread()) { "World-view capture requires Paper's primary thread" } }
    private fun warn(now: Long, failure: Throwable) {
        failed = true
        if (now - warnedAt < 5_000) { suppressed++; return }
        plugin.logger.log(Level.WARNING, "World-view capture failed; bounded retry continues suppressed=$suppressed", failure)
        warnedAt = now; suppressed = 0
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun placed(e: BlockPlaceEvent) = dirty(e.block.world.uid, ChunkKey(e.block.x shr 4, e.block.z shr 4))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun broken(e: BlockBreakEvent) = dirty(e.block.world.uid, ChunkKey(e.block.x shr 4, e.block.z shr 4))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun grown(e: BlockGrowEvent) = dirty(e.block.world.uid, ChunkKey(e.block.x shr 4, e.block.z shr 4))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun formed(e: BlockFormEvent) = dirty(e.block.world.uid, ChunkKey(e.block.x shr 4, e.block.z shr 4))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun spread(e: BlockSpreadEvent) = dirty(e.block.world.uid, ChunkKey(e.block.x shr 4, e.block.z shr 4))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun faded(e: BlockFadeEvent) = dirty(e.block.world.uid, ChunkKey(e.block.x shr 4, e.block.z shr 4))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun burned(e: BlockBurnEvent) = dirty(e.block.world.uid, ChunkKey(e.block.x shr 4, e.block.z shr 4))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun exploded(e: EntityExplodeEvent) { e.blockList().take(32).forEach { dirty(it.world.uid, ChunkKey(it.x shr 4, it.z shr 4)) } }
    @EventHandler fun loaded(e: ChunkLoadEvent) = dirty(e.world.uid, ChunkKey(e.chunk.x, e.chunk.z))
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun unloaded(e: ChunkUnloadEvent) {
        checkMain(); if (!current()) return
        val key = ChunkKey(e.chunk.x, e.chunk.z)
        scenes.values.filter { it.worldId == e.world.uid }.forEach { removeChunk(it, key) }
    }
    @EventHandler fun entitiesLoaded(e: EntitiesLoadEvent) { if (current()) e.entities.take(96).forEach { hint(entityHints, it) } }
    @EventHandler fun entitiesUnloaded(e: EntitiesUnloadEvent) { if (current()) e.entities.take(96).forEach { hint(retiredEntityHints, it) } }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun spawned(e: EntitySpawnEvent) { if (current()) hint(entityHints, e.entity) }
    @EventHandler fun joined(e: PlayerJoinEvent) { if (current()) hint(entityHints, e.player) }
    @EventHandler fun quit(e: PlayerQuitEvent) { if (current()) hint(retiredEntityHints, e.player) }
    private fun hint(queue: ArrayDeque<Entity>, entity: Entity) { if (queue.size < 256) queue.addLast(entity) }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) fun worldUnloaded(e: WorldUnloadEvent) {
        if (!current()) return
        scenes.values.filter { it.worldId == e.world.uid }.forEach { owner -> owner.slots.keys.forEach { removeChunk(owner, it) } }
        nativeActors.entries.removeIf { it.value.worldId == e.world.uid }; catalogAt = 0
    }

    override fun close() {
        checkMain()
        if (!closed.compareAndSet(false, true)) return
        timer?.cancel(); timer = null
        listener?.close(); listener = null
        HandlerList.unregisterAll(this)
        scenes.values.forEach { it.fence.active.set(false); it.published.chunks.clear() }
        scenes.clear(); nativeActors.clear(); entityHints.clear(); retiredEntityHints.clear(); discoveryOffsets.clear(); cache.clear(); cachedBytes = 0
        results.clear(); errors.clear()
        synchronized(publication) { model.scenes.clear(); model.catalog = null; model.health = null; model.ready = false }
        contribution = RuntimeHealthContribution(state = RuntimeHealthState.DOWN)
        ready.completeExceptionally(CancellationException("World-view capture stopped"))
    }

    private companion object {
        val SCENE_ID = Regex("[a-zA-Z0-9:_-]{1,128}")
        const val MAX_CACHE_BYTES = 64L * 1024 * 1024
    }
}

internal fun captureActiveScenes(access: Map<String, Long>, now: Long, idleMillis: Long, limit: Int,
    cursor: Long = 0): List<String> {
    val eligible = access.entries.asSequence().filter { it.value > 0 && now - it.value <= idleMillis }
        .map { it.key }.sorted().toList()
    if (eligible.isEmpty() || limit <= 0) return emptyList()
    val start = Math.floorMod(cursor, eligible.size.toLong()).toInt()
    return (eligible.drop(start) + eligible.take(start)).take(limit)
}

/** Resource service order is independent from the rotating admission phase. */
internal class CaptureSceneLane {
    private val attempted = hashMapOf<String, Long>()
    private var sequence = 0L
    fun order(active: Collection<String>): List<String> = active.sortedWith(
        compareBy<String> { attempted[it] ?: Long.MIN_VALUE }.thenBy { it })
    fun attempted(id: String) { attempted[id] = ++sequence }
    fun retain(eligible: Collection<String>) { attempted.keys.retainAll(eligible.toSet()) }
}

internal fun captureChunkUrl(sceneId: String, key: ChunkKey, revision: Long, epoch: String): String =
    "v1/scenes/$sceneId/chunks/${key.x}/${key.z}/$revision.json?epoch=$epoch"

private fun <T> rotate(values: List<T>, cursor: Int): List<T> =
    if (values.isEmpty()) values else Math.floorMod(cursor, values.size).let { values.drop(it) + values.take(it) }

/** Checks before each indivisible native operation; this cannot preempt an operation already entered. */
internal class CaptureTickBudget(private val started: Long, budgetNanos: Long, chunks: Int, entities: Int) {
    private val nanos = budgetNanos.coerceIn(1, 1_500_000)
    private val chunkLimit = chunks.coerceIn(1, 1)
    private val entityLimit = entities.coerceIn(1, 96)
    var chunkCount = 0; private set
    var entityCount = 0; private set
    fun hasTime(now: Long) = now - started < nanos
    fun claimChunk(now: Long): Boolean = (hasTime(now) && chunkCount < chunkLimit).also { if (it) chunkCount++ }
    fun claimEntity(now: Long): Boolean = (hasTime(now) && entityCount < entityLimit).also { if (it) entityCount++ }
}

/** A dirty hint during an in-flight copy does not reject that copy; unload invalidates it. */
internal class CaptureChunkState {
    var dirty = true; private set
    var inFlight = false; private set
    var attemptedAt = 0L
    var capturedAt = 0L
    private var generation = 0L
    private var etag: String? = null
    private var revision = 0L
    fun changed() { dirty = true }
    fun invalidate() { generation++; dirty = true }
    fun begin(): Long { check(!inFlight); inFlight = true; dirty = false; return generation }
    fun failed() { inFlight = false; dirty = true }
    fun accept(ticket: Long, value: String, next: () -> Long): Long? {
        check(inFlight); inFlight = false
        if (generation != ticket) return null
        if (etag != value) { etag = value; revision = next() }
        return revision
    }
}
