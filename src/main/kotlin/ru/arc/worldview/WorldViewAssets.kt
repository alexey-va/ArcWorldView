package ru.arc.worldview

import com.google.gson.JsonParser
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Duration
import java.util.LinkedHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** A manifest allowlist of generated renderer assets. All methods run away from Main. */
class WorldViewAssets private constructor(val revision: String, private val root: Path,
    private val entries: Map<String, AssetEntry>, private val manifest: WirePayload) : AutoCloseable {
    private data class AssetEntry(val sha256: String, val size: Long, val contentType: String)
    private val cache = LinkedHashMap<String, WirePayload>(16, 0.75f, true)
    private var cacheSize = 0L
    private val knownSkins = LinkedHashMap<String, Unit>(16, 0.75f, true)
    private val skinCache = LinkedHashMap<String, WirePayload>(16, 0.75f, true)
    private val skinClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
        .followRedirects(HttpClient.Redirect.NEVER).build()
    @Volatile private var closed = false

    @Synchronized fun allowSkinHash(hash: String) {
        if (closed || !hash.matches(SKIN_HASH)) return
        knownSkins[hash] = Unit
        while (knownSkins.size > 256) { val first = knownSkins.keys.first(); knownSkins.remove(first); skinCache.remove(first) }
    }

    fun skin(hash: String): WirePayload? {
        synchronized(this) {
            if (closed || hash !in knownSkins) return null
            skinCache[hash]?.let { return it }
        }
        val request = HttpRequest.newBuilder(URI("https://textures.minecraft.net/texture/$hash"))
            .timeout(Duration.ofSeconds(6)).header("User-Agent", "RusCrafting-ArcWorldView").GET().build()
        // The request timeout may stop at response headers. Bound the complete body too;
        // a stalled texture response must not retain the shared HTTP pool indefinitely.
        val future = skinClient.sendAsync(request, HttpResponse.BodyHandlers.limiting(HttpResponse.BodyHandlers.ofByteArray(), 262_144))
        val response = try { future.get(6, TimeUnit.SECONDS) }
            catch (_: TimeoutException) { future.cancel(true); return null }
            catch (interrupted: InterruptedException) { future.cancel(true); Thread.currentThread().interrupt(); throw interrupted }
        val bytes = response.body()
        if (response.statusCode() != 200 || bytes.size > 262_144 || bytes.size < 8 ||
            !bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10))) return null
        val payload = WirePayload.of(bytes).let { WirePayload(it.bytes, it.gzip, it.etag, "image/png") }
        synchronized(this) {
            if (!closed && hash in knownSkins) skinCache[hash] = payload
        }
        return payload
    }

    fun asset(path: String): WirePayload? {
        if (closed || path.isEmpty() || path.length > 512) return null
        if (path == "manifest.json") return manifest
        val entry = entries[path] ?: return null
        synchronized(this) { cache[path]?.let { return it } }
        val file = safeFile(root, path)
        val bytes = Files.readAllBytes(file)
        require(bytes.size.toLong() == entry.size && sha256(bytes) == entry.sha256) { "Renderer asset changed after manifest validation: $path" }
        val encoded = WirePayload.of(bytes)
        val payload = WirePayload(encoded.bytes, encoded.gzip, encoded.etag, entry.contentType)
        synchronized(this) {
            if (!closed) {
                cache.put(path, payload)?.let { cacheSize -= it.size }
                cacheSize += payload.size
                while (cacheSize > 64L * 1024 * 1024 && cache.size > 1) {
                    val old = cache.entries.first(); cacheSize -= old.value.size; cache.remove(old.key)
                }
            }
        }
        return payload
    }

    override fun close() {
        closed = true
        skinClient.shutdownNow()
        synchronized(this) { cache.clear(); knownSkins.clear(); skinCache.clear(); cacheSize = 0 }
    }

    companion object {
        private val SKIN_HASH = Regex("[a-f0-9]{64}")
        private val SHA = Regex("[a-f0-9]{64}")
        private val MIME = setOf("application/json", "application/json; charset=utf-8", "image/png", "image/webp", "text/plain")
        fun load(settings: WorldViewSettings): WorldViewAssets {
            val assets = settings.assetsRoot.toAbsolutePath().normalize()
            require(Files.isDirectory(assets) && !Files.isSymbolicLink(assets)) { "Generated renderer assets are missing" }
            val revision = if (settings.assetRevision == "current") {
                val selector = assets.resolve("current.json")
                require(Files.size(selector) <= 4096 && !Files.isSymbolicLink(selector))
                JsonParser.parseString(Files.readString(selector)).asJsonObject.get("revision").asString
            } else settings.assetRevision
            require(revision.matches(Regex("[a-zA-Z0-9_-]{1,96}")))
            val root = safeFile(assets, revision, directory = true)
            val file = safeFile(root, "manifest.json")
            require(Files.size(file) <= 4 * 1024 * 1024)
            val bytes = Files.readAllBytes(file)
            val json = JsonParser.parseString(String(bytes, Charsets.UTF_8)).asJsonObject
            require(json.get("schemaVersion").asInt == 1 && json.get("revision").asString == revision)
            require(json.get("minecraftVersion").asString == "1.21.11")
            val files = json.getAsJsonObject("files")
            require(files.size() in 1..16_384)
            var total = 0L
            val entries = files.entrySet().associate { (name, value) ->
                val item = value.asJsonObject
                val size = item.get("size").asLong.also { require(it in 0..32L * 1024 * 1024) }
                total += size; require(total <= 512L * 1024 * 1024)
                val sha = item.get("sha256").asString.also { require(it.matches(SHA)) }
                val type = item.get("contentType").asString.also { require(it in MIME) }
                val path = safeFile(root, name)
                require(Files.size(path) == size && sha256(Files.readAllBytes(path)) == sha) { "Renderer asset hash differs: $name" }
                name to AssetEntry(sha, size, type)
            }
            return WorldViewAssets(revision, root, entries, WirePayload.of(bytes))
        }

        internal fun safeFile(root: Path, relative: String, directory: Boolean = false): Path {
            require(relative.isNotBlank() && relative.length <= 512 && '\\' !in relative && '\u0000' !in relative)
            val input = Path.of(relative)
            require(!input.isAbsolute && input.none { it.toString() in setOf(".", "..") || it.toString().startsWith('.') })
            val target = root.resolve(input).normalize()
            require(target.startsWith(root))
            var current = root
            for (part in input) { current = current.resolve(part); require(!Files.isSymbolicLink(current)) }
            require(if (directory) Files.isDirectory(target) else Files.isRegularFile(target))
            return target
        }
        private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
