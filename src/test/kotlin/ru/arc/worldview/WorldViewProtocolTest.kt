package ru.arc.worldview

import com.google.gson.Gson
import com.google.gson.JsonParser
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockk
import org.bukkit.ChunkSnapshot
import org.bukkit.block.data.BlockData
import org.bukkit.configuration.file.YamlConfiguration
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream

class WorldViewProtocolTest : FunSpec({
    test("cached actor sample time survives frame serialization independently of frame time") {
        val actor = CapturedActor("native:example", "player", "player", "Player", listOf(1.0, 64.0, 2.0),
            0f, 0f, 0f, "STANDING", 1.0, false, null, emptyList(), sampledAt = 1_000)
        val wire = ActorWire.wire(actor) {}
        fun json(at: Long) = JsonParser.parseString(String(WirePayload.json(
            SceneFrame("spawn", "epoch", at, at, false, 0, 0, listOf(wire), emptyList(), emptyList())
        ).bytes)).asJsonObject
        json(1_200)["entities"].asJsonArray[0].asJsonObject["sampledAt"].asLong shouldBe 1_000
        json(1_400)["entities"].asJsonArray[0].asJsonObject["sampledAt"].asLong shouldBe 1_000
        val next = ActorWire.wire(actor.copy(sampledAt = 1_500)) {}
        next.sampledAt shouldBe 1_500
        val legacy = ActorWire.wire(actor.copy(sampledAt = null)) {}
        JsonParser.parseString(String(WirePayload.json(legacy).bytes)).asJsonObject.has("sampledAt") shouldBe false
    }

    test("six opaque full neighbours hide interior identities without changing solid occupancy") {
        fun block(state: String, occluding: Boolean = true, full: Boolean = true) = mockk<BlockData>().also { data ->
            every { data.asString } returns state
            every { data.isOccluding } returns occluding
            every { data.isFaceSturdy(any(), any()) } returns full
        }
        val stone = block("minecraft:stone")
        val diamond = block("minecraft:diamond_block")
        val gold = block("minecraft:gold_block")
        val air = block("minecraft:air", false)
        val glass = block("minecraft:glass", false)
        val slab = block("minecraft:oak_slab[type=bottom,waterlogged=false]", true, false)
        fun encode(neighbor: BlockData): com.google.gson.JsonObject {
            val snapshot = mockk<ChunkSnapshot>()
            every { snapshot.getBlockData(any(), any(), any()) } answers {
                when (Triple(firstArg<Int>(), secondArg<Int>(), thirdArg<Int>())) {
                    Triple(8, 8, 8) -> diamond
                    Triple(8, 9, 8) -> neighbor
                    Triple(0, 8, 8) -> gold
                    else -> stone
                }
            }
            return JsonParser.parseString(String(ChunkEncoder.encode(snapshot, ChunkKey(0, 0),
                SceneBounds(0, 0, 0, 16, 16, 16), 0, 16).payload.bytes)).asJsonObject
        }
        val hidden = encode(stone)
        hidden.get("occludedBlocks").asInt shouldBe 14 * 14 * 14
        val palette = hidden.getAsJsonArray("palette").map { it.asString }
        ("minecraft:diamond_block" in palette) shouldBe false
        ("minecraft:gold_block" in palette) shouldBe true // Unknown neighbour outside the chunk: retained.
        val runs = hidden.getAsJsonArray("runs").map { it.asInt }.chunked(2)
        runs.sumOf { it[0] } shouldBe 4096
        runs.filter { palette[it[1]] != "minecraft:air" }.sumOf { it[0] } shouldBe 4096
        for (neighbor in listOf(air, glass, slab)) {
            ("minecraft:diamond_block" in encode(neighbor).getAsJsonArray("palette").map { it.asString }) shouldBe true
        }
    }

    test("RLE preserves negative chunk coordinates, absolute Y and bounded XZ coverage") {
        val snapshot = mockk<ChunkSnapshot>()
        val stone = mockk<BlockData>()
        every { stone.asString } returns "minecraft:stone"
        every { snapshot.getBlockData(any(), any(), any()) } answers {
            secondArg<Int>() shouldBe 56 + ((secondArg<Int>() - 56).coerceIn(0, 15))
            stone
        }
        val bounds = SceneBounds(-1, 56, -1, 1, 72, 1)
        val encoded = ChunkEncoder.encode(snapshot, ChunkKey(-1, -1), bounds, -64, 320)
        val body = JsonParser.parseString(String(encoded.payload.bytes)).asJsonObject
        body.get("minY").asInt shouldBe 56
        val palette = body.getAsJsonArray("palette").map { it.asString }
        val runs = body.getAsJsonArray("runs").map { it.asInt }
        var count = 0
        var stoneCount = 0
        runs.chunked(2).forEach { (length, index) -> count += length; if (palette[index] == "minecraft:stone") stoneCount += length }
        count shouldBe 16 * 256
        stoneCount shouldBe 16
        GZIPInputStream(encoded.payload.gzip.inputStream()).use { it.readAllBytes() }.contentEquals(encoded.payload.bytes) shouldBe true
    }

    test("profile URLs cannot turn the skin endpoint into an arbitrary network fetch") {
        val known = mutableListOf<String>()
        fun actor(url: String) = CapturedActor("npc", "npc", "player", "Resident", listOf(0.0, 64.0, 0.0),
            0f, 0f, 0f, "STANDING", 1.0, false, Base64.getEncoder().encodeToString(
                "{\"textures\":{\"SKIN\":{\"url\":\"$url\"}}}".toByteArray()), emptyList())
        ActorWire.wire(actor("http://127.0.0.1/private"), known::add).skin shouldBe null
        known.size shouldBe 0
        val hash = "a".repeat(64)
        ActorWire.wire(actor("http://textures.minecraft.net/texture/$hash"), known::add).skin?.url shouldBe "v1/skins/$hash.png"
        known shouldBe listOf(hash)
    }

    test("default-hidden and vanished native players are excluded before appearance or inventory capture") {
        val hidden = mockk<org.bukkit.entity.Player>()
        every { hidden.isValid } returns true
        every { hidden.isDead } returns false
        every { hidden.isInvisible } returns false
        every { hidden.hasMetadata("vanished") } returns false
        every { hidden.isVisibleByDefault } returns false
        ActorWire.native(hidden) shouldBe null
        val vanished = mockk<org.bukkit.entity.Player>()
        val metadata = mockk<org.bukkit.metadata.MetadataValue>()
        every { vanished.isValid } returns true
        every { vanished.isDead } returns false
        every { vanished.isVisibleByDefault } returns true
        every { vanished.isInvisible } returns false
        every { vanished.hasMetadata("vanished") } returns true
        every { vanished.getMetadata("vanished") } returns listOf(metadata)
        every { metadata.asBoolean() } returns true
        ActorWire.native(vanished) shouldBe null
    }

    test("generated assets are manifest-only and reject traversal and symlink reads") {
        val root = Files.createTempDirectory("worldview-assets")
        val assets = testAssets(root)
        try {
            Files.writeString(root.resolve("test/secret.json"), "not-public")
            assets.asset("secret.json") shouldBe null
            assets.asset("../secret.json") shouldBe null
            shouldThrow<IllegalArgumentException> { WorldViewAssets.safeFile(root, "../secret.json") }
            Files.createSymbolicLink(root.resolve("test/link.json"), root.resolve("test/entities.json"))
            shouldThrow<IllegalArgumentException> { WorldViewAssets.safeFile(root, "test/link.json") }
        } finally { assets.close(); root.toFile().deleteRecursively() }
    }

    test("HTTP is read-only, epoch-safe, compresses and drains its listener") {
        val root = Files.createTempDirectory("worldview-http")
        val assets = testAssets(root)
        val model = WorldViewReadModel()
        model.catalog = WirePayload.json(mapOf("epoch" to "first", "scenes" to emptyList<String>()))
        val scene = PublishedScene(ViewerScene("spawn", "Spawn", "spawn", "world",
            SceneBounds(0, 0, 0, 16, 16, 16), SceneCamera(listOf(8.0, 8.0, 8.0), 45.0, 35.264, 32.0), "ready"))
        scene.chunks[ChunkKey(0, 0)] = PublishedChunk(1, WirePayload.json(mapOf("generation" to "current")))
        model.scenes["spawn"] = scene
        val http = WorldViewHttp(settings(root).copy(port = 0), model, assets, { null }, {})
        val client = HttpClient.newHttpClient()
        try {
            shouldThrow<java.net.BindException> {
                WorldViewHttp(settings(root).copy(port = http.port), model, assets, { null }, {})
            }
            fun request(path: String, method: String = "GET", headers: Map<String, String> = emptyMap()): HttpResponse<ByteArray> {
                val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:${http.port}$path"))
                    .method(method, HttpRequest.BodyPublishers.noBody())
                headers.forEach(builder::header)
                return client.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
            }
            val first = request("/v1/scenes")
            first.statusCode() shouldBe 200
            val etag = first.headers().firstValue("ETag").orElseThrow()
            request("/v1/scenes", headers = mapOf("If-None-Match" to etag)).statusCode() shouldBe 304
            model.catalog = WirePayload.json(mapOf("epoch" to "second", "scenes" to emptyList<String>()))
            request("/v1/scenes", headers = mapOf("If-None-Match" to etag)).statusCode() shouldBe 200
            request("/v1/scenes", "POST").statusCode() shouldBe 405
            request("/v1/scenes/not-configured/frame").statusCode() shouldBe 404
            val viewer = "00000000-0000-4000-8000-000000000001"
            request("/v1/scenes/spawn/frame?view=0,0,16,16").statusCode() shouldBe 400
            request("/v1/scenes/spawn/frame?viewer=bad&view=0,0,16,16").statusCode() shouldBe 400
            request("/v1/scenes/spawn/frame?viewer=$viewer&view=40,40,50,50").statusCode() shouldBe 400
            scene.snapshot = SceneFrame("spawn", model.epoch, 1, System.currentTimeMillis(), false, 1, 1,
                listOf(ViewerActor("npc:one", "npc", "player", "Resident", listOf(8.0, 8.0, 8.0),
                    0f, 0f, 0f, "STANDING", 1.0, false, null, emptyList())),
                listOf(ChunkDescriptor(0, 0, 1, "chunk")), emptyList())
            val scoped = request("/v1/scenes/spawn/frame?after=0&viewer=$viewer&view=0,0,16,16")
            scoped.statusCode() shouldBe 200
            JsonParser.parseString(String(scoped.body())).asJsonObject.getAsJsonObject("view").get("maxX").asInt shouldBe 16
            request("/v1/scenes/spawn/entities/npc%3Aone").statusCode() shouldBe 425
            scene.informationRequests(System.currentTimeMillis()).single().payload = WirePayload.json(
                ViewerEntityInfo("npc:one", "resident", "Resident", listOf(ViewerInfoField("profession", "Профессия", "Лесоруб")), 1))
            val information = request("/v1/scenes/spawn/entities/npc%3Aone")
            information.statusCode() shouldBe 200
            JsonParser.parseString(String(information.body())).asJsonObject.getAsJsonArray("fields").single()
                .asJsonObject.get("value").asString shouldBe "Лесоруб"
            request("/v1/scenes/spawn/entities/private").statusCode() shouldBe 404
            request("/v1/scenes/spawn/entities/npc%3Aone?unexpected=1").statusCode() shouldBe 400
            request("/v1/skins/${"b".repeat(64)}.png").statusCode() shouldBe 404
            request("/v1/scenes/spawn/chunks/0/0/1.json").statusCode() shouldBe 410
            request("/v1/scenes/spawn/chunks/0/0/1.json?epoch=retired").statusCode() shouldBe 410
            request("/v1/scenes/spawn/chunks/0/0/1.json?epoch=${model.epoch}").statusCode() shouldBe 200
            val compressed = request("/v1/scenes", headers = mapOf("Accept-Encoding" to "gzip"))
            compressed.headers().firstValue("Content-Encoding").orElse("") shouldBe "gzip"
            GZIPInputStream(compressed.body().inputStream()).use { String(it.readAllBytes()) }.contains("second") shouldBe true
            request("/v1/scenes", headers = mapOf("Accept-Encoding" to "gzip;q=0")).headers().firstValue("Content-Encoding").isEmpty shouldBe true
        } finally {
            http.close(); http.drained().get(5, TimeUnit.SECONDS)
            client.shutdownNow(); assets.close(); root.toFile().deleteRecursively()
        }
    }
})

private fun settings(root: java.nio.file.Path) = WorldViewSettings.load(YamlConfiguration().apply {
    set("assets-root", root.toString()); set("asset-revision", "test")
}, root)

private fun testAssets(root: java.nio.file.Path): WorldViewAssets {
    val folder = Files.createDirectories(root.resolve("test"))
    val bytes = "{}".toByteArray()
    Files.write(folder.resolve("entities.json"), bytes)
    val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    Files.writeString(folder.resolve("manifest.json"), Gson().toJson(mapOf("schemaVersion" to 1, "revision" to "test",
        "minecraftVersion" to "1.21.11", "files" to mapOf("entities.json" to mapOf("sha256" to sha, "size" to bytes.size, "contentType" to "application/json")))))
    return WorldViewAssets.load(settings(root))
}
