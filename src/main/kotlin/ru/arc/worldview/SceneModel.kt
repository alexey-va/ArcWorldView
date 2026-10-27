package ru.arc.worldview

import com.google.gson.Gson
import org.bukkit.ChunkSnapshot
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.zip.GZIPOutputStream

/** Half-open authored observation window, never an instruction to load chunks. */
data class SceneBounds(val minX: Int, val minY: Int, val minZ: Int, val maxX: Int, val maxY: Int, val maxZ: Int) {
    init {
        require(minX < maxX && minZ < maxZ && minY < maxY)
        require((maxY - minY) % 16 == 0 && maxY - minY in 16..256)
        require(maxX.toLong() - minX <= 256 && maxZ.toLong() - minZ <= 256)
    }
    val height: Int get() = maxY - minY
    fun contains(x: Double, y: Double, z: Double) = x >= minX && x < maxX && y >= minY && y < maxY && z >= minZ && z < maxZ
    fun chunks(): List<ChunkKey> = buildList {
        for (z in (minZ shr 4)..((maxZ - 1) shr 4)) for (x in (minX shr 4)..((maxX - 1) shr 4)) add(ChunkKey(x, z))
    }
}
data class ChunkKey(val x: Int, val z: Int)
data class SceneCamera(val target: List<Double>, val azimuthDegrees: Double, val elevationDegrees: Double, val spanBlocks: Double)
data class ViewerScene(val id: String, val name: String, val kind: String, val world: String, val bounds: SceneBounds,
    val camera: SceneCamera, val status: String)
data class SceneCatalog(val schemaVersion: Int, val minecraftVersion: String, val assetRevision: String,
    val assetsUrl: String, val scenes: List<ViewerScene>)
data class ChunkDescriptor(val x: Int, val z: Int, val revision: Long, val url: String)
data class ActorSkin(val url: String, val model: String)
data class ViewerActor(val id: String, val kind: String, val type: String, val name: String,
    val position: List<Double>, val yawDegrees: Float, val headYawDegrees: Float, val pitchDegrees: Float,
    val pose: String, val scale: Double, val seated: Boolean, val skin: ActorSkin?, val equipment: List<Any>,
    val display: Map<String, Any?>? = null)
data class SceneFrame(val sceneId: String, val epoch: String, val seq: Long, val capturedAt: Long, val reset: Boolean,
    val loadedChunks: Int, val totalChunks: Int, val entities: List<ViewerActor>, val chunks: List<ChunkDescriptor>,
    val removedChunks: List<ChunkKey>)

/** All serialization/compression callers belong to the bounded background worker. */
class WirePayload(val bytes: ByteArray, val gzip: ByteArray, val etag: String, val contentType: String = "application/json; charset=utf-8") {
    val size: Int get() = bytes.size + gzip.size
    companion object {
        private val gson = Gson()
        fun json(value: Any): WirePayload = of(gson.toJson(value).toByteArray(Charsets.UTF_8))
        fun of(bytes: ByteArray): WirePayload {
            val compressed = ByteArrayOutputStream().also { output -> GZIPOutputStream(output).use { it.write(bytes) } }.toByteArray()
            val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            return WirePayload(bytes, compressed, "\"$sha\"")
        }
    }
}

data class EncodedChunk(val payload: WirePayload)

/** Pure conversion of a thread-safe native chunk snapshot; never touches World/Block/Entity. */
object ChunkEncoder {
    fun encode(snapshot: ChunkSnapshot, key: ChunkKey, bounds: SceneBounds, worldMinY: Int, worldMaxY: Int): EncodedChunk {
        val palette = mutableListOf("minecraft:air")
        val indices = hashMapOf("minecraft:air" to 0)
        val runs = ArrayList<Int>()
        var previous = -1
        var count = 0
        for (y in bounds.minY until bounds.maxY) for (z in 0..15) for (x in 0..15) {
            val worldX = (key.x shl 4) + x
            val worldZ = (key.z shl 4) + z
            val state = if (worldX < bounds.minX || worldX >= bounds.maxX || worldZ < bounds.minZ || worldZ >= bounds.maxZ ||
                y < worldMinY || y >= worldMaxY) "minecraft:air" else snapshot.getBlockData(x, y, z).asString
            val index = indices.getOrPut(state) { palette.add(state); palette.lastIndex }
            if (index == previous) count++ else {
                if (count > 0) { runs.add(count); runs.add(previous) }
                previous = index; count = 1
            }
        }
        if (count > 0) { runs.add(count); runs.add(previous) }
        return EncodedChunk(WirePayload.json(mapOf("x" to key.x, "z" to key.z, "minY" to bounds.minY,
            "height" to bounds.height, "palette" to palette, "runs" to runs)))
    }
}
