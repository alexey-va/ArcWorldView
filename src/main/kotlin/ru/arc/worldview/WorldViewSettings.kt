package ru.arc.worldview

import org.bukkit.configuration.file.FileConfiguration
import java.nio.file.Path

data class FixedLocation(val id: String, val name: String, val kind: String, val world: String,
    val center: List<Double>, val radius: Int)

data class WorldViewSettings(val bind: String, val port: Int, val assetsRoot: Path, val assetRevision: String,
    val publicUrl: String, val budgetNanos: Long, val chunksPerTick: Int, val entitySamples: Int, val entityLimit: Int,
    val activeScenes: Int, val maxRadius: Int, val minY: Int, val maxY: Int, val idleMillis: Long,
    val refreshMillis: Long, val cacheBytes: Long, val workerThreads: Int, val workerQueue: Int,
    val fixedLocations: List<FixedLocation>, val discoverSettlements: Boolean) {
    companion object {
        fun load(config: FileConfiguration, dataFolder: Path): WorldViewSettings {
            val bind = config.getString("http.bind", "127.0.0.1")!!
            require(bind in setOf("127.0.0.1", "::1")) { "HTTP must remain loopback-only behind the TLS proxy" }
            val port = config.getInt("http.port", 25912).also { require(it in 1024..65535) }
            val minY = config.getInt("capture.min-y", 0)
            val maxY = config.getInt("capture.max-y", 160)
            require(minY >= -2048 && maxY <= 2048 && (maxY - minY) % 16 == 0 && maxY - minY in 16..256)
            val radius = config.getInt("capture.max-radius", 128).also { require(it in 16..128) }
            val fixed = config.getConfigurationSection("locations")?.let { section ->
                require(section.getKeys(false).size <= 32)
                section.getKeys(false).sorted().map { id ->
                    require(id.matches(Regex("[a-zA-Z0-9_-]{1,80}")))
                    val entry = requireNotNull(section.getConfigurationSection(id))
                    val center = entry.getList("center")?.map { (it as? Number)?.toDouble() ?: error("Invalid location center") }
                        ?: listOf(0.0, 70.0, 0.0)
                    require(center.size == 3 && center.all { it.isFinite() && kotlin.math.abs(it) <= 30_000_000 })
                    val name = entry.getString("name", id)!!.also { require(it.isNotBlank() && it.length <= 128) }
                    val world = entry.getString("world")!!.also { require(it.isNotBlank() && it.length <= 128) }
                    val r = entry.getInt("radius", 80).also { require(it in 16..radius) }
                    FixedLocation(id, name, entry.getString("kind", "location")!!.take(32), world, center, r)
                }
            }.orEmpty()
            val assets = dataFolder.resolve(config.getString("assets-root", "assets")!!).normalize()
            val revision = config.getString("asset-revision", "current")!!.also { require(it.matches(Regex("[a-zA-Z0-9_-]{1,96}"))) }
            val budget = config.getDouble("capture.tick-budget-ms", 1.5).also { require(it.isFinite() && it in 0.1..1.5) }
            fun limited(key: String, fallback: Int, range: IntRange) = config.getInt(key, fallback).also { require(it in range) { key } }
            return WorldViewSettings(bind, port, assets, revision, config.getString("public-url", "https://rus-crafting.ru/world")!!,
                (budget * 1_000_000).toLong(), limited("capture.chunks-per-tick", 1, 1..1),
                limited("capture.entity-samples-per-tick", 96, 8..96), limited("capture.entity-limit", 512, 16..512),
                limited("capture.active-scenes", 2, 1..2), radius, minY, maxY,
                limited("capture.idle-seconds", 15, 5..120) * 1000L,
                limited("capture.refresh-seconds", 30, 2..120) * 1000L,
                limited("capture.chunk-cache-mib", 64, 8..128) * 1024L * 1024L,
                limited("capture.worker-threads", 2, 1..2), limited("capture.worker-queue", 8, 2..16), fixed,
                config.getBoolean("discover-settlements", true))
        }
    }
}
