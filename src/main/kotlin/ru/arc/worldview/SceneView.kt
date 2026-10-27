package ru.arc.worldview

/** Conservative camera footprint, half-open and always clipped to an authored scene. */
data class SceneView(val minX: Int, val minZ: Int, val maxX: Int, val maxZ: Int) {
    init { require(minX < maxX && minZ < maxZ) { "Empty viewport" } }
    fun clip(bounds: SceneBounds): SceneView = SceneView(
        maxOf(minX, bounds.minX), maxOf(minZ, bounds.minZ),
        minOf(maxX, bounds.maxX), minOf(maxZ, bounds.maxZ))
    fun intersects(key: ChunkKey): Boolean = key.x.toLong() * 16 < maxX &&
        key.x.toLong() * 16 + 16 > minX && key.z.toLong() * 16 < maxZ && key.z.toLong() * 16 + 16 > minZ
    fun contains(position: List<Double>): Boolean = position[0] >= minX && position[0] < maxX &&
        position[2] >= minZ && position[2] < maxZ
    fun bounds(scene: SceneBounds): SceneBounds = SceneBounds(minX, scene.minY, minZ, maxX, scene.maxY, maxZ)
    fun chunks(): List<ChunkKey> = buildList {
        for (z in (minZ shr 4)..((maxZ - 1) shr 4)) for (x in (minX shr 4)..((maxX - 1) shr 4)) add(ChunkKey(x, z))
    }
    companion object {
        fun full(bounds: SceneBounds) = SceneView(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ)
        fun parse(value: String): SceneView {
            val parts = value.split(',')
            require(parts.size == 4) { "Viewport needs four integer coordinates" }
            val values = parts.map { requireNotNull(it.toIntOrNull()) { "Invalid viewport coordinate" } }
            return SceneView(values[0], values[1], values[2], values[3])
        }
    }
}
