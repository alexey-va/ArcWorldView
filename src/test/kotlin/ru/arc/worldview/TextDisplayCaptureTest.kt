package ru.arc.worldview

import com.google.gson.Gson
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockk
import net.kyori.adventure.key.Key
import net.kyori.adventure.text.Component
import net.kyori.adventure.text.event.ClickEvent
import net.kyori.adventure.text.event.HoverEvent
import net.kyori.adventure.text.format.NamedTextColor
import net.kyori.adventure.text.format.TextColor
import net.kyori.adventure.text.format.TextDecoration
import org.bukkit.Color
import org.bukkit.entity.TextDisplay

class TextDisplayCaptureTest : FunSpec({
    test("style runs retain inherited colors and decorations without click or hover payloads") {
        val component = Component.empty().color(NamedTextColor.GOLD).decorate(TextDecoration.BOLD)
            .append(Component.text("Ключ "))
            .append(Component.text("×3", NamedTextColor.GREEN).decoration(TextDecoration.BOLD, false)
                .font(Key.key("minecraft", "default")))
            .clickEvent(ClickEvent.runCommand("/private-command"))
            .hoverEvent(HoverEvent.showText(Component.text("private-hover")))
        val content = TextDisplayCapture.content(component)
        content.text shouldBe "Ключ ×3"
        val runs = requireNotNull(content.runs)
        runs.size shouldBe 2
        runs[0].color shouldBe NamedTextColor.GOLD.value()
        runs[0].bold shouldBe true
        runs[1].color shouldBe NamedTextColor.GREEN.value()
        runs[1].bold shouldBe false
        val json = Gson().toJson(content)
        json.contains("private-command") shouldBe false
        json.contains("private-hover") shouldBe false
    }

    test("the detached native style preserves opacity background alignment and flags") {
        val display = mockk<TextDisplay>()
        every { display.text() } returns Component.text("Новые биомы", NamedTextColor.AQUA)
        every { display.lineWidth } returns 512
        every { display.alignment } returns TextDisplay.TextAlignment.RIGHT
        every { display.backgroundColor } returns Color.fromARGB(0, 0, 0, 0)
        every { display.isDefaultBackground } returns false
        every { display.textOpacity } returns (-1).toByte()
        every { display.isShadowed } returns true
        every { display.isSeeThrough } returns false
        val captured = TextDisplayCapture.native(display)
        captured["text"] shouldBe "Новые биомы"
        val style = captured["textStyle"] as ViewerTextStyle
        style.lineWidth shouldBe 512
        style.alignment shouldBe "RIGHT"
        style.backgroundColor shouldBe 0
        style.opacity shouldBe 255
        style.shadow shouldBe true
        style.defaultBackground shouldBe false
        style.seeThrough shouldBe false
    }

    test("text bounds do not split supplementary characters and excessive formatting uses plain fallback") {
        val text = TextDisplayCapture.content(Component.text("😀".repeat(300)))
        text.text.codePointCount(0, text.text.length) shouldBe 256
        text.text.endsWith("😀") shouldBe true
        var component = Component.empty()
        repeat(70) { index -> component = component.append(Component.text("x", TextColor.color(index))) }
        val fallback = TextDisplayCapture.content(component)
        fallback.text.length shouldBe 70
        fallback.runs shouldBe null
    }

    test("component traversal is bounded even when empty nodes precede visible text") {
        var component = Component.empty()
        repeat(600) { component = component.append(Component.empty().color(NamedTextColor.RED)) }
        component = component.append(Component.text("outside-node-budget"))
        TextDisplayCapture.content(component).text shouldBe ""
    }

    test("private native displays are rejected before any appearance is captured") {
        val display = mockk<TextDisplay>()
        every { display.isValid } returns true
        every { display.isDead } returns false
        every { display.isVisibleByDefault } returns false
        ActorWire.native(display) shouldBe null
    }
})
