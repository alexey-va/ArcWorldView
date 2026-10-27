package ru.arc.worldview

import net.kyori.adventure.text.Component
import org.bukkit.entity.TextDisplay
import ru.arc.paper.api.ArcSceneTextRun
import ru.arc.paper.scene.PaperSceneSnapshots

internal data class ViewerTextStyle(
    val lineWidth: Int, val alignment: String, val backgroundColor: Int,
    val defaultBackground: Boolean, val opacity: Int, val shadow: Boolean,
    val seeThrough: Boolean, val runs: List<ArcSceneTextRun>?,
)

/** Native capture on Main; the shared allowlist strips events and bounds traversal. */
internal object TextDisplayCapture {
    fun content(component: Component) = PaperSceneSnapshots.textContent(component)

    fun native(display: TextDisplay): Map<String, Any> {
        val content = content(display.text())
        val style = ViewerTextStyle(display.lineWidth.coerceIn(1, 4096), display.alignment.name,
            display.backgroundColor?.asARGB() ?: 0x40000000, display.isDefaultBackground,
            display.textOpacity.toInt() and 0xff, display.isShadowed, display.isSeeThrough, content.runs)
        return mapOf("kind" to "text", "text" to content.text, "textStyle" to style)
    }
}
