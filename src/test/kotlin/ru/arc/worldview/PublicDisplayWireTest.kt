package ru.arc.worldview

import com.google.gson.JsonParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import ru.arc.paper.api.*
import java.util.UUID

class PublicDisplayWireTest : FunSpec({
    fun pose(x: Double) = ArcSceneDisplayPose(x, 72.0, -4.0, 30f, 0f,
        ArcSceneVector3(0f, .2f, 0f), ArcSceneVector3(.5f, .5f, .5f),
        ArcSceneQuaternion(0f, 0f, 0f, 1f), ArcSceneQuaternion(0f, 0f, 0f, 1f))
    val item = ArcSceneItem("minecraft:diamond", 1, 123, 0xabcdef, "ruscrafting:public_prize")

    test("public item transforms and forward timeline survive the real JSON wire") {
        val timeline = ArcSceneDisplayTimeline(1_000, 40.0, 100,
            listOf(ArcSceneDisplayKeyframe(pose(1.0), 0), ArcSceneDisplayKeyframe(pose(2.0), 0)), listOf(item),
            listOf(ArcSceneDisplayItemSwitch(0, 0)))
        val source = ArcSceneDisplay(UUID.randomUUID(), "ecia:anchor:ambient:0", pose(1.0), "CENTER",
            15, 15, 20f, 0f, 1f, ArcSceneDisplayContent.Item(item, "GROUND"), timeline)
        val actor = ActorWire.wire(ActorWire.observedDisplay(source)) { error("No skin should be resolved") }
        val json = JsonParser.parseString(String(WirePayload.json(actor).bytes)).asJsonObject
        json["kind"].asString shouldBe "display"
        json["type"].asString shouldBe "item_display"
        json["position"].asJsonArray[0].asDouble shouldBe 1.0
        val display = json["display"].asJsonObject
        display["mode"].asString shouldBe "GROUND"
        display["blockLight"].asInt shouldBe 15
        display["item"].asJsonObject["itemModel"].asString shouldBe "ruscrafting:public_prize"
        display["translation"].asJsonArray[1].asFloat shouldBe .2f
        val animation = display["animation"].asJsonObject
        animation["capturedAt"].asLong shouldBe 1_000
        animation["sampleMillis"].asInt shouldBe 100
        animation["samples"].asJsonArray[1].asJsonObject["position"].asJsonArray[0].asDouble shouldBe 2.0
        animation["items"].asJsonArray.size() shouldBe 1
        animation["itemSwitches"].asJsonArray.single().asJsonObject["offsetMillis"].asInt shouldBe 0
        json["equipment"].asJsonArray.size() shouldBe 0
    }

    test("canonical public caption retains native text style without a viewer identity") {
        val text = ArcSceneTextContent("Кейс", listOf(ArcSceneTextRun("Кейс", 0xffaa00, "minecraft:default",
            true, false, false, false, false)))
        val source = ArcSceneDisplay(UUID.randomUUID(), "ecia:anchor:caption", pose(1.0), "CENTER",
            null, null, 1f, 0f, 1f,
            ArcSceneDisplayContent.Text(text, 200, "RIGHT", 0, false, 255, true, false), null)
        val captured = ActorWire.observedDisplay(source)
        captured.type shouldBe "text_display"
        val display = requireNotNull(captured.display)
        display["text"] shouldBe "Кейс"
        val style = display["textStyle"] as ViewerTextStyle
        style.alignment shouldBe "RIGHT"
        style.backgroundColor shouldBe 0
        style.runs!!.single().bold shouldBe true
        display["animation"] shouldBe null
    }
})
