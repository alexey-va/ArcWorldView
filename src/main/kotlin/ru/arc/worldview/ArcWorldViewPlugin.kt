package ru.arc.worldview

import org.bukkit.Bukkit
import org.bukkit.plugin.java.JavaPlugin
import ru.arc.config.EmptyConfig
import ru.arc.core.BoundedAsyncExecutor
import ru.arc.core.PaperArcRuntime
import ru.arc.logging.ArcLogging
import ru.arc.logging.LoggingConfigSource
import ru.arc.logging.paper.PaperLoggingPlatform
import ru.arc.observability.RuntimeHealthContribution
import ru.arc.observability.RuntimeHealthState
import ru.arc.paper.api.ArcSceneObservationService
import ru.arc.paper.runtime.PaperPluginHotload
import ru.arc.paper.runtime.PaperPluginRuntime
import ru.arc.text.LocaleCatalog
import ru.arc.text.LocalizedMiniMessage
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.logging.Level

/** One owned generation; HTTP never calls a Bukkit object and cleanup never waits on Main. */
class ArcWorldViewPlugin : JavaPlugin() {
    private var runtime: PaperPluginRuntime? = null
    private var http: WorldViewHttp? = null
    private var worker: BoundedAsyncExecutor? = null
    private var workerDrain = CompletableFuture.completedFuture(Unit)
    private var closeDrain = CompletableFuture.completedFuture(Unit)
    private var stopped = true
    private val hotload = PaperPluginHotload(this, ::stopRuntime)
    private val messages = LocalizedMiniMessage(mapOf("ru" to catalog(mapOf(
        "prefix" to "", "status" to "<gray>ArcWorldView: <state></gray>", "url" to "<aqua><url></aqua>"
    )), "en" to catalog(mapOf("prefix" to "", "status" to "<gray>ArcWorldView: <state></gray>", "url" to "<aqua><url></aqua>"))), { "ru" })

    override fun onEnable() {
        check(closeDrain.isDone && !closeDrain.isCompletedExceptionally) { "Previous WorldView generation has not drained" }
        hotload.beginGeneration()
        hotload.register()
        PaperArcRuntime.installScheduling(this)
        ArcLogging.install(PaperLoggingPlatform("ArcWorldView", "ArcWorldView"), LoggingConfigSource { EmptyConfig })
        stopped = false
        val model = WorldViewReadModel()
        val lifecycle = PaperPluginRuntime(this, "arc-world-view").also { runtime = it; it.start("version" to pluginMeta.version) }
        lifecycle.registerHealth("viewer") {
            if (model.ready) RuntimeHealthContribution(state = RuntimeHealthState.UP, dependencies = mapOf("scene_observer" to true, "assets" to true))
            else RuntimeHealthContribution(state = if (stopped) RuntimeHealthState.DOWN else RuntimeHealthState.STARTING)
        }
        lifecycle.reportHealthEvery(1200L)
        try {
            saveDefaultConfig()
            val settings = WorldViewSettings.load(config, dataPath)
            val observer = requireNotNull(server.servicesManager.load(ArcSceneObservationService::class.java)) { "ArcCore 0.1.22 scene observer is required" }
            val executor = BoundedAsyncExecutor("ArcWorldView-capture", settings.workerThreads, settings.workerQueue).also { worker = it }
            lifecycle.own(AutoCloseable { workerDrain = executor.closeAsync() })
            val token = lifecycle.tasks.token()
            executor.submit { WorldViewAssets.load(settings) }.whenComplete { assets, failure ->
                if (failure != null) {
                    lifecycle.tasks.runSync(token) { fail(lifecycle, failure) }
                    return@whenComplete
                }
                lifecycle.tasks.callSync(token) {
                    if (stopped || runtime !== lifecycle) { assets.close(); return@callSync }
                    lifecycle.own(assets)
                    val capture = lifecycle.own(WorldViewCapture(this, lifecycle, settings, observer, executor, assets, model))
                    lifecycle.registerHealth("capture", capture::health)
                    capture.start().whenComplete { _, startFailure -> lifecycle.tasks.runSync(token) {
                        if (startFailure != null) { fail(lifecycle, startFailure); return@runSync }
                        if (stopped || runtime !== lifecycle) return@runSync
                        try {
                            http = lifecycle.own(WorldViewHttp(settings, model, assets, this::getResource, logger::warning))
                            model.ready = true
                            lifecycle.ready("port" to settings.port, "assets" to assets.revision)
                        } catch (failure: Throwable) { fail(lifecycle, failure) }
                    } }
                }.whenComplete { _, setupFailure ->
                    if (setupFailure != null) {
                        assets.close()
                        lifecycle.tasks.runSync(token) { fail(lifecycle, setupFailure) }
                    }
                }
            }
            requireNotNull(getCommand("worldview")).setExecutor { sender, _, _, _ ->
                sender.sendMessage(messages.render("status", null, mapOf("state" to messages.literal(if (model.ready) "ready" else "starting"))))
                sender.sendMessage(messages.render("url", null, mapOf("url" to messages.literal(settings.publicUrl))))
                true
            }
        } catch (failure: Throwable) { fail(lifecycle, failure) }
    }

    private fun fail(lifecycle: PaperPluginRuntime, failure: Throwable) {
        if (runtime !== lifecycle || stopped) return
        lifecycle.health.markDown()
        lifecycle.emitHealth()
        logger.log(Level.SEVERE, "ArcWorldView startup failed", failure)
        server.pluginManager.disablePlugin(this)
    }

    private fun stopRuntime(): Map<String, CompletionStage<*>> {
        check(Bukkit.isPrimaryThread())
        if (!stopped) {
            stopped = true
            runtime?.close()
            runtime = null
            hotload.retireGameplayRegistrations()
            val httpDrain = http?.drained() ?: CompletableFuture.completedFuture(Unit)
            closeDrain = CompletableFuture.allOf(workerDrain, httpDrain).thenApply { Unit }
            http = null
            worker = null
        }
        return mapOf("capture-and-assets" to closeDrain, "http" to closeDrain)
    }
    override fun onDisable() { hotload.prepare(); hotload.close() }
    private fun catalog(values: Map<String, String>) = object : LocaleCatalog {
        override fun scalar(path: String) = values[path]
        override fun lines(path: String): List<String>? = null
    }
}
