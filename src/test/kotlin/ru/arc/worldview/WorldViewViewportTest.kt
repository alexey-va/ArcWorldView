package ru.arc.worldview

import com.google.gson.JsonParser
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class WorldViewViewportTest : FunSpec({
    fun scene() = PublishedScene(ViewerScene("village", "Village", "settlement", "world",
        SceneBounds(-32, 48, -32, 32, 80, 32), SceneCamera(listOf(0.0, 64.0, 0.0), 45.0, 35.0, 64.0), "ready"))
    fun actor(id: String, x: Double) = ViewerActor(id, "npc", "player", id, listOf(x, 64.0, 0.0),
        0f, 0f, 0f, "STANDING", 1.0, false, null, emptyList())

    test("Minecraft filters actors and descriptors before serialization and retains independent camera interests") {
        val scene = scene()
        scene.snapshot = SceneFrame("village", "epoch", 7, 10, false, 4, 16,
            listOf(actor("left", -20.0), actor("right", 20.0)),
            listOf(ChunkDescriptor(-2, 0, 1, "left"), ChunkDescriptor(1, 0, 2, "right")), emptyList())
        val left = JsonParser.parseString(String(scene.frameFor("one", SceneView(-64, -16, 0, 16), 100)!!.bytes)).asJsonObject
        left.getAsJsonArray("entities").map { it.asJsonObject.get("id").asString } shouldBe listOf("left")
        left.getAsJsonArray("chunks").map { it.asJsonObject.get("url").asString } shouldBe listOf("left")
        left.get("totalChunks").asInt shouldBe 4
        left.getAsJsonObject("view").get("minX").asInt shouldBe -32
        scene.frameFor("two", SceneView(16, -16, 32, 16), 101)
        scene.captureBounds(102) shouldBe SceneBounds(-32, 48, -16, 32, 80, 16)
        val changed = JsonParser.parseString(String(scene.frameFor("one", SceneView(16, -16, 32, 16), 103)!!.bytes)).asJsonObject
        changed.get("seq").asLong shouldBe 7L
        changed.getAsJsonArray("entities").single().asJsonObject.get("id").asString shouldBe "right"
        scene.requestedViews(104).all { it.minX == 16 } shouldBe true
    }

    test("view leases are bounded and expire without discarding detached scene context") {
        val scene = scene()
        repeat(PublishedScene.MAX_VIEWERS) { scene.frameFor("v$it", SceneView(-16, -16, 16, 16), 100) }
        shouldThrow<IllegalStateException> { scene.frameFor("overflow", SceneView(-16, -16, 16, 16), 101) }
        scene.frameFor("replacement", SceneView(0, 0, 16, 16), 100 + PublishedScene.VIEW_IDLE_MILLIS + 1)
        scene.requestedViews(100 + PublishedScene.VIEW_IDLE_MILLIS + 2) shouldBe listOf(SceneView(0, 0, 16, 16))
        shouldThrow<IllegalArgumentException> { SceneView(100, 100, 120, 120).clip(scene.definition.bounds) }
        shouldThrow<IllegalArgumentException> { SceneView.parse("0,0,NaN,16") }
        SceneView(-1, -1, 1, 1).chunks().toSet() shouldBe setOf(ChunkKey(-1, -1), ChunkKey(0, -1), ChunkKey(-1, 0), ChunkKey(0, 0))
    }

    test("entity information is requested only for current public snapshot actors and stays detached") {
        val scene = scene()
        scene.snapshot = SceneFrame("village", "epoch", 1, 10, false, 0, 16,
            listOf(actor("visible", 0.0)), emptyList(), emptyList())
        shouldThrow<NoSuchElementException> { scene.informationFor("private-or-unknown", 100) }
        scene.informationRequests(100).size shouldBe 0
        scene.informationFor("visible", 100) shouldBe null
        val request = scene.informationRequests(101).single()
        request.id shouldBe "visible"
        val payload = WirePayload.json(ViewerEntityInfo("visible", "resident", "Name",
            listOf(ViewerInfoField("profession", "Профессия", "Лесоруб")), 101))
        request.payload = payload
        scene.informationFor("visible", 102) shouldBe payload
        scene.snapshot = scene.snapshot!!.copy(entities = emptyList())
        shouldThrow<NoSuchElementException> { scene.informationFor("visible", 103) }
        scene.informationRequests(104).size shouldBe 0
    }
})
