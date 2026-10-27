package ru.arc.worldview

import com.google.gson.JsonParser
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.unmockkObject
import io.mockk.verify
import org.bukkit.ChunkSnapshot
import org.bukkit.Location
import org.bukkit.block.data.BlockData
import org.bukkit.event.HandlerList
import ru.arc.core.BoundedAsyncExecutor
import ru.arc.core.TestTaskScheduler
import ru.arc.observability.RuntimeHealthState
import ru.arc.paper.api.ArcSceneObservationService
import ru.arc.paper.runtime.PaperPluginRuntime
import ru.arc.paper.testing.MockBukkitTestRuntime
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.function.LongSupplier

class WorldViewCaptureTest : FunSpec({
    test("one aggregate tick budget caps chunks entities and elapsed time at the production ceilings") {
        val budget = CaptureTickBudget(1_000, 9_000_000, 100, 1_000)
        budget.claimChunk(1_001) shouldBe true
        budget.claimChunk(1_002) shouldBe false
        repeat(96) { budget.claimEntity(1_003) shouldBe true }
        budget.claimEntity(1_004) shouldBe false
        budget.hasTime(1_500_999) shouldBe true
        budget.hasTime(1_501_000) shouldBe false
        CaptureTickBudget(0, 100, 1, 8).apply {
            repeat(8) { claimEntity(1) shouldBe true }
            claimEntity(1) shouldBe false
            hasTime(100) shouldBe false
        }
    }

    test("active selection admits only the two most recent unexpired requested scenes") {
        captureActiveScenes(mapOf("never" to 0, "old" to 84_999, "edge" to 85_000,
            "b" to 99_000, "a" to 99_000), 100_000, 15_000, 2) shouldBe listOf("a", "b")
        captureActiveScenes(mapOf("edge" to 85_000), 100_000, 15_000, 2) shouldBe listOf("edge")
        captureActiveScenes(mapOf("old" to 84_999), 100_000, 15_000, 2) shouldBe emptyList()
    }

    test("dirty during encoding publishes the accepted copy while retaining a new capture and stale unload cannot publish") {
        val state = CaptureChunkState()
        var revisions = 0L
        val first = state.begin()
        shouldThrow<IllegalStateException> { state.begin() }
        state.changed()
        state.accept(first, "one") { ++revisions } shouldBe 1L
        state.dirty shouldBe true
        val identical = state.begin()
        state.accept(identical, "one") { ++revisions } shouldBe 1L
        revisions shouldBe 1L
        state.dirty shouldBe false
        state.changed()
        val unloaded = state.begin()
        state.invalidate()
        state.accept(unloaded, "two") { ++revisions } shouldBe null
        state.dirty shouldBe true
        revisions shouldBe 1L
        val replacement = state.begin()
        state.accept(replacement, "two") { ++revisions } shouldBe 2L
        captureChunkUrl("civs:one", ChunkKey(-2, 3), 1, "generation-a") shouldBe
            "v1/scenes/civs:one/chunks/-2/3/1.json?epoch=generation-a"
        (captureChunkUrl("civs:one", ChunkKey(-2, 3), 1, "generation-a") !=
            captureChunkUrl("civs:one", ChunkKey(-2, 3), 1, "generation-b")) shouldBe true
    }

    test("RLE preserves an arbitrary minY and clips both scene sides and the native world height") {
        val stone = mockk<BlockData> { every { asString } returns "minecraft:stone" }
        val snapshot = mockk<ChunkSnapshot> { every { getBlockData(any(), any(), any()) } returns stone }
        val result = ChunkEncoder.encode(snapshot, ChunkKey(0, 0), SceneBounds(1, 17, 2, 3, 33, 4), 20, 30)
        val json = JsonParser.parseString(String(result.payload.bytes)).asJsonObject
        json["minY"].asInt shouldBe 17
        json["height"].asInt shouldBe 16
        val palette = json["palette"].asJsonArray.map { it.asString }
        val runs = json["runs"].asJsonArray.map { it.asInt }
        runs.chunked(2).sumOf { it[0] } shouldBe 4096
        runs.chunked(2).filter { palette[it[1]] == "minecraft:stone" }.sumOf { it[0] } shouldBe 40
        verify(exactly = 40) { snapshot.getBlockData(any(), any(), any()) }
    }

    test("start publishes a catalog without a viewer and close releases listeners without closing the supplied worker") {
        MockBukkitTestRuntime.open().use { paper ->
            val plugin = paper.createSimplePlugin("CaptureLifecycle")
            val world = paper.addSimpleWorld("village")
            val scheduler = TestTaskScheduler()
            val runtime = PaperPluginRuntime(plugin, "capture-test", scheduler)
            runtime.start()
            val worker = BoundedAsyncExecutor("capture-test", 1, 2)
            val fixture = CaptureAssetsFixture()
            val settings = fixture.settings(listOf(FixedLocation("village", "Village", "settlement", world.name,
                listOf(0.0, 64.0, 0.0), 16)))
            val assets = WorldViewAssets.load(settings)
            val model = WorldViewReadModel()
            val observer = mockk<ArcSceneObservationService>()
            var releases = 0
            every { observer.registerChunkListener(plugin, "world-view", any()) } returns AutoCloseable { releases++ }
            every { observer.locations(32) } returns emptyList()
            var owner: WorldViewCapture? = null
            try {
                val capture = WorldViewCapture(plugin, runtime, settings, observer, worker, assets, model).also { owner = it }
                capture.start().get(5, TimeUnit.SECONDS)
                val catalog = JsonParser.parseString(String(requireNotNull(model.catalog).bytes)).asJsonObject
                catalog["scenes"].asJsonArray.single().asJsonObject["id"].asString shouldBe "village"
                scheduler.tick()
                capture.health().state shouldBe RuntimeHealthState.UP
                capture.health().activeLeases shouldBe 0
                model.scenes["village"]!!.chunks.size shouldBe 0
                capture.close(); capture.close()
                releases shouldBe 1
                HandlerList.getRegisteredListeners(plugin).size shouldBe 0
                model.scenes.isEmpty() shouldBe true
                model.ready shouldBe false
                capture.health().state shouldBe RuntimeHealthState.DOWN
                worker.submit { capture.health().state }.get(5, TimeUnit.SECONDS) shouldBe RuntimeHealthState.DOWN
                worker.submit { 42 }.get(5, TimeUnit.SECONDS) shouldBe 42
            } finally { owner?.close(); runtime.close(); worker.closeAsync().get(5, TimeUnit.SECONDS); assets.close(); fixture.close() }
        }
    }

    test("a queued catalog completion after close cannot republish the closed generation") {
        MockBukkitTestRuntime.open().use { paper ->
            val plugin = paper.createSimplePlugin("CaptureStale")
            val runtime = PaperPluginRuntime(plugin, "capture-stale", TestTaskScheduler())
            runtime.start()
            val worker = BoundedAsyncExecutor("capture-stale", 1, 2)
            val fixture = CaptureAssetsFixture()
            val settings = fixture.settings()
            val assets = WorldViewAssets.load(settings)
            val model = WorldViewReadModel()
            val observer = mockk<ArcSceneObservationService>()
            every { observer.registerChunkListener(plugin, "world-view", any()) } returns AutoCloseable {}
            every { observer.locations(32) } returns emptyList()
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            worker.execute { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
            entered.await(5, TimeUnit.SECONDS) shouldBe true
            var owner: WorldViewCapture? = null
            try {
                val capture = WorldViewCapture(plugin, runtime, settings, observer, worker, assets, model).also { owner = it }
                val first = capture.start()
                first.isDone shouldBe false
                capture.close()
                first.isCompletedExceptionally shouldBe true
                release.countDown()
                worker.submit { Unit }.get(5, TimeUnit.SECONDS)
                model.catalog shouldBe null
                model.health shouldBe null
                model.scenes.isEmpty() shouldBe true
                model.ready shouldBe false
            } finally { release.countDown(); owner?.close(); runtime.close(); worker.closeAsync().get(5, TimeUnit.SECONDS); assets.close(); fixture.close() }
        }
    }

    test("dense chunk discovery still captures a native actor before the actor-priority tick ends") {
        MockBukkitTestRuntime.open().use { paper ->
            val plugin = paper.createSimplePlugin("CaptureDenseActors")
            val world = paper.addSimpleWorld("dense")
            world.loadChunk(0, 0)
            repeat(96) { index -> paper.addPlayer("Dense$index").teleport(Location(world, 8.0, 24.0, 8.0)) }
            val scheduler = TestTaskScheduler()
            val runtime = PaperPluginRuntime(plugin, "capture-dense", scheduler).also { it.start() }
            val worker = BoundedAsyncExecutor("capture-dense", 1, 2)
            val fixture = CaptureAssetsFixture()
            val settings = fixture.settings(listOf(FixedLocation("dense", "Dense", "settlement", world.name,
                listOf(8.0, 24.0, 8.0), 16)))
            val assets = WorldViewAssets.load(settings)
            val model = WorldViewReadModel()
            val observer = mockk<ArcSceneObservationService>()
            every { observer.registerChunkListener(plugin, "world-view", any()) } returns AutoCloseable {}
            every { observer.locations(32) } returns emptyList()
            every { observer.entities(any(), any()) } returns emptyList()
            val clock = AtomicLong()
            var owner: WorldViewCapture? = null
            mockkObject(ActorWire)
            every { ActorWire.native(any()) } answers {
                // Model one indivisible native capture using the remaining deadline. The next
                // terrain operation must wait; MockBukkit does not implement the four-flag snapshot.
                clock.set(2_000_000)
                CapturedActor("native:${firstArg<org.bukkit.entity.Entity>().uniqueId}", "player", "player", "Dense",
                    listOf(8.0, 24.0, 8.0), 0f, 0f, 0f, "STANDING", 1.0, false, null, emptyList())
            }
            try {
                val capture = WorldViewCapture(plugin, runtime, settings, observer, worker, assets, model,
                    LongSupplier(clock::get)).also { owner = it }
                capture.start().get(5, TimeUnit.SECONDS)
                model.frame("dense") // The real HTTP read path activates this scene.
                scheduler.tick()
                verify(exactly = 1) { ActorWire.native(any()) }
                capture.health().state shouldBe RuntimeHealthState.UP
            } finally {
                owner?.close(); runtime.close(); worker.closeAsync().get(5, TimeUnit.SECONDS)
                unmockkObject(ActorWire); assets.close(); fixture.close()
            }
        }
    }
})

private class CaptureAssetsFixture : AutoCloseable {
    private val directory = Files.createTempDirectory("world-view-capture-assets")
    init {
        val revision = directory.resolve("fixture")
        Files.createDirectories(revision)
        val content = "{}".toByteArray()
        Files.write(revision.resolve("data.json"), content)
        val hash = MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) }
        Files.writeString(revision.resolve("manifest.json"),
            """{"schemaVersion":1,"revision":"fixture","minecraftVersion":"1.21.11","files":{"data.json":{"size":2,"sha256":"$hash","contentType":"application/json"}}}""")
    }
    fun settings(fixed: List<FixedLocation> = emptyList()) = WorldViewSettings("127.0.0.1", 25912, directory,
        "fixture", "https://example.test/world", 1_500_000, 1, 96, 512, 2, 128, 17, 33,
        15_000, 30_000, 64L * 1024 * 1024, 1, 2, fixed, true)
    override fun close() { Files.walk(directory).use { it.sorted(Comparator.reverseOrder()).forEach(Files::delete) } }
}
