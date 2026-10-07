package live.cohub.android.display

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Build
import android.os.Process
import android.util.Log
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "CohubDisplay"

@RequiresApi(Build.VERSION_CODES.R)
internal class DisplayProvider(
    private val spaceId: String,
    private val socket: File,
    private val display: DeviceDisplay,
) {
    suspend fun serve() = coroutineScope {
        socket.parentFile?.mkdirs()
        socket.delete()
        val address = LocalSocketAddress(socket.path, LocalSocketAddress.Namespace.FILESYSTEM)
        val bound = LocalSocket().apply { bind(address) }
        val server = LocalServerSocket(bound.fileDescriptor)
        val stopping = AtomicBoolean(false)
        // Blocking accept() ignores interrupts and close(); a connection of our own wakes it.
        val waker = launch {
            try {
                awaitCancellation()
            } finally {
                stopping.set(true)
                runCatching { LocalSocket().use { it.connect(address) } }
            }
        }
        try {
            while (true) {
                val client = runInterruptible(Dispatchers.IO) { server.accept() }
                if (stopping.get()) {
                    client.close()
                    break
                }
                if (client.peerCredentials.uid != Process.myUid()) {
                    Log.w(TAG, "Refused a display connection from uid ${client.peerCredentials.uid}")
                    client.close()
                    continue
                }
                launch(Dispatchers.IO) { Connection(client).run() }
            }
        } finally {
            waker.cancel()
            runCatching { server.close() }
            runCatching { bound.close() }
            socket.delete()
        }
    }

    private inner class Connection(private val client: LocalSocket) {
        private val writer = DisplayWire.Writer(client.outputStream)
        private val streams = mutableMapOf<Int, Stream>()
        private val calls = ConcurrentHashMap<Long, Job>()

        private inner class Stream(val id: Int, val capture: ScreenCapture) : StreamSink {
            @Volatile var open = true

            override fun sample(data: ByteArray, length: Int, ptsUs: Long, key: Boolean) {
                if (!open) return
                try {
                    writer.media(id, ptsUs, key, data, length)
                } catch (_: IOException) {
                    open = false
                }
            }

            override fun ended(error: DisplayError?) {
                synchronized(streams) { streams.remove(id) }
                if (open) runCatching { writer.json(DisplayWire.ended(id, error)) }
                open = false
            }
        }

        suspend fun run() = coroutineScope {
            // A blocked read ignores cancellation; closing the socket ends it.
            val closer = launch {
                try {
                    awaitCancellation()
                } finally {
                    runCatching { client.close() }
                }
            }
            val watcher = launch {
                display.changes.collect { runCatching { writer.json(DisplayWire.displays(display.displays(spaceId))) } }
            }
            try {
                writer.json(DisplayWire.hello("android"))
                val reader = DisplayWire.reader(client.inputStream)
                while (true) {
                    val message = runInterruptible { DisplayWire.read(reader) } ?: break
                    if (message.string("type") == "call") call(message)
                }
            } catch (error: IOException) {
                Log.i(TAG, "Display connection closed: ${error.message}")
            } finally {
                watcher.cancel()
                closer.cancel()
                val open = synchronized(streams) { streams.values.toList().also { streams.clear() } }
                open.forEach { it.open = false; it.capture.unsubscribe(it) }
                runCatching { client.close() }
            }
        }

        private fun CoroutineScope.call(message: JsonObject) {
            val id = message["id"]?.jsonPrimitive?.longOrNull ?: 0L
            if (message.string("method") == "cancel") {
                (message["params"] as? JsonObject)?.get("id")?.jsonPrimitive?.longOrNull?.let { calls[it]?.cancel() }
                return
            }
            val job = launch(start = CoroutineStart.LAZY) { handle(message) }
            if (id != 0L) {
                calls[id] = job
                job.invokeOnCompletion { calls.remove(id, job) }
            }
            job.start()
        }

        private suspend fun handle(call: JsonObject) {
            val id = call["id"]?.jsonPrimitive?.longOrNull ?: 0L
            val params = call["params"] as? JsonObject ?: JsonObject(emptyMap())
            val reply = try {
                DisplayWire.reply(id, dispatch(call.string("method"), params))
            } catch (error: CancellationException) {
                throw error
            } catch (error: DisplayError) {
                DisplayWire.reply(id, error)
            } catch (error: Exception) {
                Log.w(TAG, "Display call failed", error)
                DisplayWire.reply(id, DisplayError(DisplayError.FAILED, error.message ?: "display call failed"))
            }
            if (id != 0L) runCatching { writer.json(reply) }
        }

        private suspend fun dispatch(method: String?, params: JsonObject): JsonElement? = when (method) {
            "stream.start" -> {
                val stream = params.int("stream") ?: throw DisplayError(DisplayError.INVALID, "stream is required")
                val capture = display.capture(spaceId, params.string("display").orEmpty())
                val sink = Stream(stream, capture)
                synchronized(streams) { streams.put(stream, sink) }?.let { it.open = false; it.capture.unsubscribe(it) }
                capture.subscribe(sink, params.int("bitrate") ?: ScreenCapture.DEFAULT_BITRATE)
                null
            }
            "stream.stop" -> {
                val sink = synchronized(streams) { streams.remove(params.int("stream")) }
                sink?.let { it.open = false; it.capture.unsubscribe(it) }
                null
            }
            "stream.update" -> {
                val sink = synchronized(streams) { streams[params.int("stream")] }
                val bitrate = params.int("bitrate")
                if (sink != null && bitrate != null) sink.capture.setBitrate(sink, bitrate)
                null
            }
            "stream.keyframe" -> {
                synchronized(streams) { streams[params.int("stream")] }?.capture?.requestKeyFrame()
                null
            }
            "capture" -> {
                val capture = display.capture(spaceId, params.string("display").orEmpty())
                    .capture(params.string("format") ?: "jpeg", params.int("quality") ?: 90, params.int("maxSize") ?: 0)
                buildJsonObject {
                    put("mimeType", capture.mimeType)
                    put("data", capture.base64)
                    put("width", capture.width)
                    put("height", capture.height)
                }
            }
            "tree" -> display.tree(
                spaceId,
                params.string("display").orEmpty(),
                (params.int("maxElements") ?: DisplayVocabulary.DEFAULT_TREE_ELEMENTS).coerceIn(1, DisplayVocabulary.MAX_TREE_ELEMENTS),
            )
            "input" -> {
                val events = params["events"] as? JsonArray ?: throw DisplayError(DisplayError.INVALID, "events are required")
                display.input(spaceId, params.string("display").orEmpty(), InputEvent.parseAll(events), params.long("startBy") ?: 0L)
                JsonNull
            }
            else -> throw DisplayError(DisplayError.UNSUPPORTED, "unsupported method $method")
        }
    }
}

private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

private fun JsonObject.int(key: String): Int? = this[key]?.jsonPrimitive?.intOrNull

private fun JsonObject.long(key: String): Long? = this[key]?.jsonPrimitive?.longOrNull

@RequiresApi(Build.VERSION_CODES.R)
internal fun CoroutineScope.launchDisplayProvider(spaceId: String, socket: File, display: DeviceDisplay) =
    launch {
        try {
            DisplayProvider(spaceId, socket, display).serve()
        } catch (error: IOException) {
            Log.w(TAG, "Display provider unavailable for $spaceId", error)
        }
    }
