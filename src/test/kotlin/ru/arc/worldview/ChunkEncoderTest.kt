package ru.arc.worldview

import com.google.gson.JsonParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockk
import org.bukkit.ChunkSnapshot
import org.bukkit.block.BlockFace
import org.bukkit.block.BlockSupport
import org.bukkit.block.data.BlockData

class ChunkEncoderTest : FunSpec({
    test("serializes each complete block state once across cloned snapshot cells") {
        val states = listOf(
            EncoderState("minecraft:stone", true, true),
            EncoderState("minecraft:oak_log[axis=x]", true, true),
            EncoderState("minecraft:oak_log[axis=z]", true, true),
            EncoderState("minecraft:oak_slab[type=bottom,waterlogged=false]", true, false),
            EncoderState("minecraft:oak_slab[type=top,waterlogged=true]", true, false),
            EncoderState("minecraft:air"),
            EncoderState("minecraft:cave_air"),
            EncoderState("minecraft:barrier", true, null),
        )
        val reads = ArrayList<Triple<Int, Int, Int>>()
        val strings = mutableMapOf<String, Int>()
        val opaqueChecks = mutableMapOf<String, Int>()
        val snapshot = encoderSnapshot(reads, strings, opaqueChecks) { x, y, z ->
            states[Math.floorMod(x + 3 * z + 5 * y, states.size)]
        }
        val bounds = SceneBounds(0, -64, 0, 16, 64, 16)

        val body = JsonParser.parseString(String(ChunkEncoder.encode(snapshot, ChunkKey(0, 0),
            bounds, -64, 320).payload.bytes)).asJsonObject

        reads.size shouldBe 32_768
        body.getAsJsonArray("runs").map { it.asInt }.chunked(2).sumOf { it[0] } shouldBe reads.size
        strings shouldBe states.associate { it.text to 1 }
        opaqueChecks shouldBe states.filter { it.text != "minecraft:air" }.associate { it.text to 1 }
    }

    test("wire bytes preserve properties air occlusion and clipped unknown boundaries") {
        val reads = ArrayList<Triple<Int, Int, Int>>()
        val snapshot = encoderSnapshot(reads, mutableMapOf(), mutableMapOf()) { x, y, z ->
            when (Triple(x, y, z)) {
                Triple(8, -55, 8) -> EncoderState("minecraft:diamond_block", true, true)
                Triple(1, -55, 8) -> EncoderState("minecraft:gold_block", true, true)
                Triple(4, -62, 4) -> EncoderState("minecraft:oak_log[axis=x]", true, true)
                Triple(5, -62, 4) -> EncoderState("minecraft:oak_log[axis=z]", true, true)
                Triple(4, -55, 4) -> EncoderState("minecraft:oak_slab[type=bottom,waterlogged=false]", true, false)
                Triple(5, -55, 4) -> EncoderState("minecraft:oak_slab[type=top,waterlogged=true]", true, false)
                Triple(6, -55, 6) -> EncoderState("minecraft:air")
                Triple(7, -55, 6) -> EncoderState("minecraft:cave_air")
                Triple(10, -55, 10) -> EncoderState("minecraft:barrier", true, null)
                Triple(10, -55, 11) -> EncoderState("minecraft:emerald_block", true, true)
                else -> EncoderState("minecraft:stone", true, true)
            }
        }
        val bounds = SceneBounds(-15, -63, 17, -1, -47, 31)
        val payload = ChunkEncoder.encode(snapshot, ChunkKey(-1, 1), bounds, -62, -48).payload
        val body = JsonParser.parseString(String(payload.bytes)).asJsonObject
        val palette = body.getAsJsonArray("palette").map { it.asString }

        reads.size shouldBe 14 * 14 * 14
        reads.all { (x, y, z) -> x in 1..14 && y in -62 until -48 && z in 1..14 } shouldBe true
        body["x"].asInt shouldBe -1
        body["z"].asInt shouldBe 1
        body["minY"].asInt shouldBe -63
        body["height"].asInt shouldBe 16
        ("minecraft:diamond_block" in palette) shouldBe false
        ("minecraft:gold_block" in palette) shouldBe true
        ("minecraft:emerald_block" in palette) shouldBe true
        ("minecraft:barrier" in palette) shouldBe true
        palette.count { it == "minecraft:air" } shouldBe 1
        ("minecraft:cave_air" in palette) shouldBe true
        palette.count { it.startsWith("minecraft:oak_log[") } shouldBe 2
        palette.count { it.startsWith("minecraft:oak_slab[") } shouldBe 2
        // Frozen from the original string-keyed encoder, including palette order and RLE.
        payload.etag shouldBe "\"075dc2aa29cea294f2f95ca16ee76236cc044004249163679b77a610a92ead51\""
    }
})

private data class EncoderState(val text: String, val occluding: Boolean = false, val full: Boolean? = false)

private fun encoderSnapshot(reads: MutableList<Triple<Int, Int, Int>>, strings: MutableMap<String, Int>,
    opaqueChecks: MutableMap<String, Int>, state: (Int, Int, Int) -> EncoderState): ChunkSnapshot {
    val snapshot = mockk<ChunkSnapshot>()
    val unused = mockk<BlockData>()
    every { snapshot.getBlockData(any(), any(), any()) } answers {
        val x = firstArg<Int>(); val y = secondArg<Int>(); val z = thirdArg<Int>()
        reads.add(Triple(x, y, z))
        // CraftChunkSnapshot returns distinct wrappers for equal native states.
        EncoderBlockData(state(x, y, z), strings, opaqueChecks, unused)
    }
    return snapshot
}

private class EncoderBlockData(private val state: EncoderState, private val strings: MutableMap<String, Int>,
    private val opaqueChecks: MutableMap<String, Int>, unused: BlockData) : BlockData by unused {
    override fun getAsString(): String {
        strings.merge(state.text, 1, Int::plus)
        return state.text
    }
    override fun isOccluding(): Boolean {
        opaqueChecks.merge(state.text, 1, Int::plus)
        return state.occluding
    }
    override fun isFaceSturdy(face: BlockFace, support: BlockSupport): Boolean =
        state.full ?: throw UnsupportedOperationException("Unknown fixture shape")
    override fun equals(other: Any?): Boolean = other is EncoderBlockData && state == other.state
    override fun hashCode(): Int = 1 // Exercise collisions as well as equal cloned states.
}
