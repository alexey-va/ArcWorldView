package ru.arc.worldview

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** HTTP sees only these detached publications, never a Bukkit handle or a capture callback. */
class WorldViewReadModel {
    val epoch: String = UUID.randomUUID().toString()
    val scenes = ConcurrentHashMap<String, PublishedScene>()
    @Volatile var catalog: WirePayload? = null
    @Volatile var health: WirePayload? = null
    @Volatile var ready = false
    fun frame(id: String, viewer: String? = null, view: SceneView? = null): WirePayload? =
        scenes[id]?.frameFor(viewer ?: "legacy", view, System.currentTimeMillis())
    fun chunk(id: String, key: ChunkKey, revision: Long): WirePayload? =
        scenes[id]?.chunks?.get(key)?.takeIf { it.revision == revision }?.payload
    fun information(scene: String, entity: String): WirePayload? =
        scenes[scene]?.informationFor(entity, System.currentTimeMillis())
}

class EntityInfoRequest(val id: String, val access: AtomicLong) {
    @Volatile var payload: WirePayload? = null
}

class PublishedScene(@Volatile var definition: ViewerScene) {
    val lastAccess = AtomicLong(0)
    @Volatile var frame: WirePayload? = null
    @Volatile var snapshot: SceneFrame? = null
    val chunks = ConcurrentHashMap<ChunkKey, PublishedChunk>()
    private class ViewerLease(@Volatile var view: SceneView, val access: AtomicLong) {
        @Volatile var cached: CachedView? = null
    }
    private data class CachedView(val sequence: Long, val view: SceneView, val payload: WirePayload)
    private val viewers = ConcurrentHashMap<String, ViewerLease>()
    private val information = ConcurrentHashMap<String, EntityInfoRequest>()

    fun informationFor(id: String, now: Long): WirePayload? {
        val current = snapshot ?: return null
        if (current.entities.none { it.id == id }) throw NoSuchElementException("Entity is outside the public snapshot")
        val request = synchronized(information) {
            information.entries.removeIf { now - it.value.access.get() > VIEW_IDLE_MILLIS }
            information[id]?.also { it.access.set(now) } ?: run {
                check(information.size < 64) { "Entity information capacity reached" }
                EntityInfoRequest(id, AtomicLong(now)).also { information[id] = it }
            }
        }
        lastAccess.set(now)
        return request.payload
    }

    fun informationRequests(now: Long): List<EntityInfoRequest> {
        val current = snapshot?.entities?.mapTo(hashSetOf()) { it.id } ?: return emptyList()
        return information.values.filter { now - it.access.get() <= VIEW_IDLE_MILLIS && it.id in current }
    }

    /** HTTP threads filter detached DTOs before any JSON/gzip leaves the Minecraft host. */
    fun frameFor(viewer: String, requested: SceneView?, now: Long): WirePayload? {
        val accepted = (requested ?: SceneView.full(definition.bounds)).clip(definition.bounds)
        val lease = synchronized(viewers) {
            viewers.entries.removeIf { now - it.value.access.get() > VIEW_IDLE_MILLIS }
            viewers[viewer]?.also { it.view = accepted; it.access.set(now) } ?: run {
                check(viewers.size < MAX_VIEWERS) { "Viewport capacity reached" }
                ViewerLease(accepted, AtomicLong(now)).also { viewers[viewer] = it }
            }
        }
        lastAccess.set(now)
        val current = snapshot ?: return if (requested == null) frame else null
        lease.cached?.takeIf { it.sequence == current.seq && it.view == accepted }?.let { return it.payload }
        val visibleChunks = current.chunks.filter { accepted.intersects(ChunkKey(it.x, it.z)) }
        val filtered = current.copy(view = accepted, loadedChunks = visibleChunks.size,
            totalChunks = accepted.chunks().size,
            entities = current.entities.filter { accepted.contains(it.position) }, chunks = visibleChunks,
            removedChunks = current.removedChunks.filter(accepted::intersects))
        return WirePayload.json(filtered).also {
            if (it.size <= MAX_CACHED_VIEW_BYTES) lease.cached = CachedView(current.seq, accepted, it)
        }
    }

    /** Main reads only immutable view coordinates; no HTTP serialization lock is held. */
    fun captureBounds(now: Long): SceneBounds {
        val live = requestedViews(now)
        return SceneView(live.minOf { it.minX }, live.minOf { it.minZ },
            live.maxOf { it.maxX }, live.maxOf { it.maxZ }).clip(definition.bounds).bounds(definition.bounds)
    }

    fun requestedViews(now: Long): List<SceneView> = viewers.values
        .filter { now - it.access.get() <= VIEW_IDLE_MILLIS }.map { it.view }
        .ifEmpty { listOf(SceneView.full(definition.bounds)) }

    companion object {
        const val VIEW_IDLE_MILLIS = 15_000L
        const val MAX_VIEWERS = 16
        const val MAX_CACHED_VIEW_BYTES = 32 * 1024
    }
}
data class PublishedChunk(val revision: Long, val payload: WirePayload)
