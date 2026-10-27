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
    fun frame(id: String): WirePayload? = scenes[id]?.let {
        it.lastAccess.set(System.currentTimeMillis())
        it.frame
    }
    fun chunk(id: String, key: ChunkKey, revision: Long): WirePayload? =
        scenes[id]?.chunks?.get(key)?.takeIf { it.revision == revision }?.payload
}

class PublishedScene(@Volatile var definition: ViewerScene) {
    val lastAccess = AtomicLong(0)
    @Volatile var frame: WirePayload? = null
    val chunks = ConcurrentHashMap<ChunkKey, PublishedChunk>()
}
data class PublishedChunk(val revision: Long, val payload: WirePayload)
