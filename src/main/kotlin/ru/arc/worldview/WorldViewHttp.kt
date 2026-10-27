package ru.arc.worldview

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import ru.arc.core.BoundedAsyncExecutor
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Loopback HTTP transport; handlers only read detached publications and asset files. */
class WorldViewHttp(settings: WorldViewSettings, private val model: WorldViewReadModel,
    private val assets: WorldViewAssets, private val resource: (String) -> java.io.InputStream?,
    private val warning: (String) -> Unit) : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress(settings.bind, settings.port), 32)
    private val io = try { BoundedAsyncExecutor("ArcWorldView-http", 4, 32) }
        catch (failure: Throwable) { server.stop(0); throw failure }
    private val static = ConcurrentHashMap<String, WirePayload>()
    private val closed = AtomicBoolean(false)
    val port: Int get() = server.address.port
    @Volatile private var drain = CompletableFuture.completedFuture(Unit)
    init {
        try {
            server.executor = io
            server.createContext("/", ::handle)
            server.start()
        } catch (failure: Throwable) {
            server.stop(0)
            io.closeAsync()
            throw failure
        }
    }
    fun drained(): CompletableFuture<Unit> = drain.copy()

    private fun handle(exchange: HttpExchange) {
        try {
            exchange.responseHeaders.set("X-Content-Type-Options", "nosniff")
            exchange.responseHeaders.set("Referrer-Policy", "same-origin")
            exchange.responseHeaders.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'")
            if (closed.get()) return error(exchange, 503, "stopped")
            if (exchange.requestMethod !in setOf("GET", "HEAD")) {
                exchange.responseHeaders.set("Allow", "GET, HEAD")
                return error(exchange, 405, "read-only")
            }
            if (exchange.requestHeaders.getFirst("Content-Length")?.toLongOrNull()?.let { it > 0 } == true ||
                exchange.requestHeaders.getFirst("Transfer-Encoding") != null) return error(exchange, 400, "unexpected-body")
            val path = exchange.requestURI.path
            if (path.length > 1024 || '\u0000' in path || '\\' in path) return error(exchange, 400, "invalid-path")
            val parts = path.trim('/').split('/').filter(String::isNotEmpty)
            if (parts.any { it == "." || it == ".." }) return error(exchange, 400, "invalid-path")
            when {
                parts == listOf("v1", "scenes") -> respond(exchange, model.catalog ?: return error(exchange, 503, "warming"), false)
                parts == listOf("v1", "health") -> respond(exchange, model.health ?: return error(exchange, 503, "warming"), false)
                parts.size == 4 && parts[0] == "v1" && parts[1] == "scenes" && parts[3] == "frame" -> {
                    val id = parts[2]
                    if (!validScene(id) || !model.scenes.containsKey(id)) return error(exchange, 404, "scene-not-found")
                    respond(exchange, model.frame(id) ?: return error(exchange, 425, "warming"), false)
                }
                parts.size == 7 && parts[0] == "v1" && parts[1] == "scenes" && parts[3] == "chunks" -> {
                    val id = parts[2]
                    if (!validScene(id) || !model.scenes.containsKey(id)) return error(exchange, 404, "scene-not-found")
                    // Revisions restart with the capture owner. Never serve a different generation
                    // under an old immutable cache key, including a cold request after restart.
                    if (exchange.requestURI.rawQuery != "epoch=${model.epoch}")
                        return error(exchange, 410, "chunk-epoch-retired")
                    val x = parts[4].toIntOrNull() ?: return error(exchange, 400, "invalid-chunk")
                    val z = parts[5].toIntOrNull() ?: return error(exchange, 400, "invalid-chunk")
                    val revision = parts[6].removeSuffix(".json").toLongOrNull() ?: return error(exchange, 400, "invalid-revision")
                    respond(exchange, model.chunk(id, ChunkKey(x, z), revision) ?: return error(exchange, 410, "chunk-revision-retired"), true)
                }
                parts.size == 3 && parts[0] == "v1" && parts[1] == "skins" -> {
                    val hash = parts[2].removeSuffix(".png")
                    respond(exchange, assets.skin(hash) ?: return error(exchange, 404, "skin-not-found"), true)
                }
                parts.size >= 3 && parts[0] == "assets" && parts[1] == assets.revision -> {
                    respond(exchange, assets.asset(parts.drop(2).joinToString("/")) ?: return error(exchange, 404, "asset-not-found"), true)
                }
                else -> {
                    val name = if (parts.isEmpty()) "index.html" else parts.joinToString("/")
                    if (!name.matches(Regex("[a-zA-Z0-9_./-]{1,256}")) || name.substringAfterLast('.', "") !in setOf("html", "js", "css", "woff2", "png", "svg", "ico", "json", "txt"))
                        return error(exchange, 404, "not-found")
                    val payload = static[name] ?: resource("web/$name")?.use { stream ->
                        val bytes = stream.readNBytes(16 * 1024 * 1024 + 1)
                        require(bytes.size <= 16 * 1024 * 1024)
                        val wire = WirePayload.of(bytes)
                        WirePayload(wire.bytes, wire.gzip, wire.etag, when (name.substringAfterLast('.')) {
                            "html" -> "text/html; charset=utf-8"; "js" -> "text/javascript; charset=utf-8"; "css" -> "text/css; charset=utf-8"
                            "png" -> "image/png"; "svg" -> "image/svg+xml"; "woff2" -> "font/woff2"
                            "txt" -> "text/plain; charset=utf-8"; "ico" -> "image/vnd.microsoft.icon"; else -> "application/json; charset=utf-8"
                        }).also { if (static.size < 32) static.putIfAbsent(name, it) }
                    } ?: return error(exchange, 404, "not-found")
                    respond(exchange, payload, false)
                }
            }
        } catch (failure: Exception) {
            if (!closed.get()) warning("Viewer HTTP failed: ${failure.javaClass.simpleName}")
            runCatching { error(exchange, 503, "temporarily-unavailable") }
        } finally { exchange.close() }
    }

    private fun respond(exchange: HttpExchange, payload: WirePayload, immutable: Boolean) {
        exchange.responseHeaders.set("Content-Type", payload.contentType)
        exchange.responseHeaders.set("Cache-Control", if (immutable) "public, max-age=31536000, immutable" else "no-cache")
        exchange.responseHeaders.set("ETag", payload.etag)
        exchange.responseHeaders.set("Vary", "Accept-Encoding")
        if (exchange.requestHeaders.getFirst("If-None-Match") == payload.etag) { exchange.sendResponseHeaders(304, -1); return }
        val gzip = exchange.requestHeaders.getFirst("Accept-Encoding")?.split(',')?.any {
            val pieces = it.trim().split(';').map(String::trim)
            pieces.first() == "gzip" && pieces.drop(1).firstOrNull { parameter -> parameter.startsWith("q=") }
                ?.removePrefix("q=")?.toDoubleOrNull()?.let { quality -> quality > 0 } != false
        } == true
        val bytes = if (gzip) payload.gzip else payload.bytes
        if (gzip) exchange.responseHeaders.set("Content-Encoding", "gzip")
        if (exchange.requestMethod == "HEAD") { exchange.responseHeaders.set("Content-Length", bytes.size.toString()); exchange.sendResponseHeaders(200, -1); return }
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
    private fun error(exchange: HttpExchange, status: Int, code: String) {
        val bytes = "{\"error\":\"$code\"}".toByteArray()
        exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        exchange.responseHeaders.set("Cache-Control", "no-store")
        exchange.sendResponseHeaders(status, if (exchange.requestMethod == "HEAD") -1 else bytes.size.toLong())
        if (exchange.requestMethod != "HEAD") exchange.responseBody.use { it.write(bytes) }
    }
    private fun validScene(value: String) = value.matches(Regex("[a-zA-Z0-9:_-]{1,128}"))

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        server.stop(0)
        static.clear()
        drain = io.closeAsync()
    }
}
