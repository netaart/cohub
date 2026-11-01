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
import kotlinx.serialization.json.booleanOrNull
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

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
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

        private inner class Stream(val id: Int, val capture: Screen) : StreamSink {
            @Volatile var open = true
            private val unfollow = DisplayControl.followFocus(capture.displayId)

            fun close() {
                open = false
                capture.unsubscribe(this)
                unfollow()
            }

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
                unfollow()
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
                display.changes.collect {
                    runCatching {
                        writer.json(DisplayWire.displays(display.displays(spaceId), display.virtual(spaceId)))
                        display.served().filter { it.spaceId == spaceId && it.held }.forEach { writer.json(DisplayWire.hold(it.screen.id, true)) }
                    }
                }
            }
            val focus = launch {
                var last = emptyMap<String, JsonObject?>()
                display.focus(spaceId).collect { all ->
                    for ((id, focus) in all) if (last[id] != focus) runCatching { writer.json(DisplayWire.focus(id, focus)) }
                    for (id in last.keys - all.keys) runCatching { writer.json(DisplayWire.focus(id, null)) }
                    last = all
                }
            }
            val events = launch {
                display.messages.collect { if (it.spaceId == spaceId) runCatching { writer.json(it.message) } }
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
                focus.cancel()
                events.cancel()
                closer.cancel()
                val open = synchronized(streams) { streams.values.toList().also { streams.clear() } }
                open.forEach { it.close() }
                display.disconnected(spaceId)
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

        private suspend fun dispatch(method: String?, params: JsonObject): JsonElement? {
            val id = params.string("display").orEmpty()
            return when (method) {
                "stream.start" -> {
                    val stream = params.int("stream") ?: throw DisplayError(DisplayError.INVALID, "stream is required")
                    val screen = display.served(spaceId, id).screen
                    val sink = Stream(stream, screen)
                    synchronized(streams) { streams.put(stream, sink) }?.close()
                    try {
                        screen.subscribe(sink, params.int("bitrate") ?: Screen.DEFAULT_BITRATE)
                    } catch (error: DisplayError) {
                        synchronized(streams) { streams.remove(stream, sink) }
                        sink.close()
                        throw error
                    }
                    null
                }
                "stream.stop" -> {
                    synchronized(streams) { streams.remove(params.int("stream")) }?.close()
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
                    val capture = display.served(spaceId, id).screen
                        .capture(params.string("format") ?: "jpeg", params.int("quality") ?: 90, params.int("maxSize") ?: 0)
                    buildJsonObject {
                        put("mimeType", capture.mimeType)
                        put("data", capture.base64)
                        put("width", capture.width)
                        put("height", capture.height)
                    }
                }
                "tree" -> display.tree(spaceId, id, (params.int("maxElements") ?: DisplayVocabulary.DEFAULT_TREE_ELEMENTS).coerceIn(1, DisplayVocabulary.MAX_TREE_ELEMENTS))
                "input" -> {
                    val events = params["events"] as? JsonArray ?: throw DisplayError(DisplayError.INVALID, "events are required")
                    display.input(spaceId, id, InputEvent.parseAll(events), params.long("startBy") ?: 0L)
                    JsonNull
                }
                "changes" -> {
                    display.watch(spaceId, id, params["watch"]?.jsonPrimitive?.booleanOrNull == true)
                    JsonNull
                }
                "activity" -> {
                    val activity = params["activity"] as? JsonObject
                    display.activity(spaceId, id, activity?.let { Activity(it.string("sessionId"), it.string("turnId"), it.string("label")) })
                    null
                }
                "launch", "open" -> {
                    display.launch(spaceId, id, params.string("app"), params.string("url"))
                    JsonNull
                }
                "apps" -> display.apps()
                "virtual.start" -> {
                    display.startAgent(spaceId)
                    JsonNull
                }
                "virtual.stop" -> {
                    display.stopAgent(spaceId)
                    JsonNull
                }
                else -> throw DisplayError(DisplayError.UNSUPPORTED, "unsupported method $method")
            }
        }
    }
}

private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

private fun JsonObject.int(key: String): Int? = this[key]?.jsonPrimitive?.intOrNull

private fun JsonObject.long(key: String): Long? = this[key]?.jsonPrimitive?.longOrNull
