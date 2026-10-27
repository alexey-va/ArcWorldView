package ru.arc.worldview

import com.google.gson.JsonParser
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer
import org.bukkit.GameMode
import org.bukkit.entity.Ageable
import org.bukkit.entity.Entity
import org.bukkit.entity.ItemDisplay
import org.bukkit.entity.BlockDisplay
import org.bukkit.entity.TextDisplay
import org.bukkit.entity.LivingEntity
import org.bukkit.entity.Player
import org.bukkit.inventory.EquipmentSlot
import ru.arc.paper.api.ArcSceneEntity
import ru.arc.paper.scene.PaperSceneSnapshots
import java.net.URI
import java.util.Base64

/** Captures native fields on Main; decoding profiles and serializing happens later. */
data class CapturedActor(val id: String, val kind: String, val type: String, val name: String,
    val position: List<Double>, val yaw: Float, val headYaw: Float, val pitch: Float, val pose: String,
    val scale: Double, val seated: Boolean, val texture: String?, val equipment: List<Any>,
    val display: Map<String, Any?>? = null)

object ActorWire {
    private val plain = PlainTextComponentSerializer.plainText()
    fun native(entity: Entity): CapturedActor? {
        if (!entity.isValid || entity.isDead || !entity.isVisibleByDefault || entity is LivingEntity && entity.isInvisible ||
            entity.hasMetadata("vanished") && entity.getMetadata("vanished").any { it.asBoolean() } ||
            entity is Player && entity.gameMode == GameMode.SPECTATOR) return null
        val location = entity.location
        val npc = entity.hasMetadata("NPC")
        val kind = when { npc -> "npc"; entity is Player -> "player"; entity is org.bukkit.entity.Display -> "display"; else -> "mob" }
        val name = if (entity is Player) entity.name else entity.customName()?.let(plain::serialize).orEmpty()
        val equipment = if (entity is LivingEntity) entity.equipment?.let { inventory ->
            listOf(EquipmentSlot.HAND, EquipmentSlot.OFF_HAND, EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET)
                .mapNotNull { slot -> visibleItem(slot, inventory.getItem(slot)) }
        }.orEmpty() else emptyList()
        val texture = if (entity is Player) entity.playerProfile.properties.firstOrNull { it.name == "textures" }?.value else null
        val scale = ((entity as? LivingEntity)?.getAttribute(org.bukkit.attribute.Attribute.SCALE)?.value ?: 1.0) *
            if (entity is Ageable && !entity.isAdult) 0.5 else 1.0
        val display = when (entity) {
            is ItemDisplay -> transform(entity) + mapOf("kind" to "item", "item" to visibleItem(EquipmentSlot.HAND, entity.itemStack),
                "mode" to entity.itemDisplayTransform.name)
            is BlockDisplay -> transform(entity) + mapOf("kind" to "block", "blockData" to entity.block.asString)
            is TextDisplay -> transform(entity) + mapOf("kind" to "text", "text" to (entity.text()?.let(plain::serialize).orEmpty().take(256)))
            else -> null
        }
        return CapturedActor("native:${entity.uniqueId}", kind, entity.type.key.key, name.take(128),
            listOf(location.x, location.y, location.z), location.yaw, location.yaw, location.pitch,
            entity.pose.name, scale.coerceIn(0.01, 16.0), entity.isInsideVehicle, texture?.take(16_384), equipment, display)
    }
    private fun visibleItem(slot: EquipmentSlot, item: org.bukkit.inventory.ItemStack): Map<String, Any?>? {
        val captured = PaperSceneSnapshots.equipment(slot, item) ?: return null
        return mapOf("slot" to captured.slot, "material" to captured.material, "amount" to captured.amount,
            "customModelData" to captured.customModelData, "tint" to captured.tint, "itemModel" to item.itemMeta?.itemModel?.toString())
    }
    private fun transform(display: org.bukkit.entity.Display): Map<String, Any> {
        val t = display.transformation
        return mapOf(
        "billboard" to display.billboard.name,
        "translation" to listOf(t.translation.x, t.translation.y, t.translation.z),
        "scale" to listOf(t.scale.x, t.scale.y, t.scale.z),
        "leftRotation" to listOf(t.leftRotation.x, t.leftRotation.y, t.leftRotation.z, t.leftRotation.w),
        "rightRotation" to listOf(t.rightRotation.x, t.rightRotation.y, t.rightRotation.z, t.rightRotation.w))
    }

    fun observed(actor: ArcSceneEntity) = CapturedActor(actor.id, "npc", actor.type, actor.name,
        listOf(actor.x, actor.y, actor.z), actor.bodyYaw, actor.headYaw, actor.pitch, actor.pose, actor.scale,
        actor.seated, actor.skinTexture, actor.equipment)

    fun wire(actor: CapturedActor, knownSkin: (String) -> Unit): ViewerActor {
        val skin = actor.texture?.let { texture -> runCatching {
            val data = JsonParser.parseString(String(Base64.getDecoder().decode(texture), Charsets.UTF_8)).asJsonObject
                .getAsJsonObject("textures").getAsJsonObject("SKIN")
            val uri = URI(data.get("url").asString)
            require(uri.host == "textures.minecraft.net" && uri.scheme in setOf("http", "https") && uri.port == -1 && uri.rawQuery == null)
            val hash = uri.path.removePrefix("/texture/")
            require(hash.matches(Regex("[a-fA-F0-9]{64}")))
            knownSkin(hash.lowercase())
            ActorSkin("v1/skins/${hash.lowercase()}.png", if (data.getAsJsonObject("metadata")?.get("model")?.asString == "slim") "slim" else "default")
        }.getOrNull() }
        return ViewerActor(actor.id, actor.kind, actor.type, actor.name, actor.position, actor.yaw, actor.headYaw,
            actor.pitch, actor.pose, actor.scale, actor.seated, skin, actor.equipment, actor.display)
    }
}
