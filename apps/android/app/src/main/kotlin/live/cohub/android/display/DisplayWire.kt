package live.cohub.android.display

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * Provider side of the sandboxd display wire protocol, version 1, mirroring
 * `apps/sandbox/display/wire.go`. Every frame is a u32 BE length, a kind byte
 * and its payload: kind 1 one JSON message, kind 2 one H.264 access unit
 * prefixed by u32 stream, u64 pts (µs) and u8 flags.
 */
internal object DisplayWire {
    const val VERSION = 1
    private const val KIND_JSON = 1
    private const val KIND_MEDIA = 2
    private const val MEDIA_HEADER = 4 + 8 + 1
    private const val FLAG_KEY = 1
    const val MAX_FRAME = 16 shl 20

    fun read(input: DataInputStream): JsonObject? {
        while (true) {
            val size = try {
                input.readInt()
            } catch (_: EOFException) {
                return null
            }
            if (size < 1 || size > MAX_FRAME) throw IOException("invalid frame size $size")
            val kind = input.readUnsignedByte()
            val payload = ByteArray(size - 1)
            input.readFully(payload)
            if (kind != KIND_JSON) continue
            return Json.parseToJsonElement(payload.decodeToString()) as? JsonObject
                ?: throw IOException("frame is not a JSON object")
        }
    }

    fun reader(stream: InputStream) = DataInputStream(stream.buffered(64 * 1024))

    class Writer(stream: OutputStream) {
        private val out = BufferedOutputStream(stream, 64 * 1024)
        private val header = ByteArray(5 + MEDIA_HEADER)

        @Synchronized
        fun json(message: JsonObject) {
            val bytes = message.toString().encodeToByteArray()
            frameHeader(1 + bytes.size, KIND_JSON)
            out.write(header, 0, 5)
            out.write(bytes)
            out.flush()
        }

        @Synchronized
        fun media(stream: Int, ptsUs: Long, key: Boolean, data: ByteArray, length: Int) {
            frameHeader(1 + MEDIA_HEADER + length, KIND_MEDIA)
            putInt(5, stream)
            putLong(9, ptsUs)
            header[17] = if (key) FLAG_KEY.toByte() else 0
            out.write(header, 0, 5 + MEDIA_HEADER)
            out.write(data, 0, length)
            out.flush()
        }

        private fun frameHeader(size: Int, kind: Int) {
            if (size > MAX_FRAME) throw IOException("frame of $size bytes exceeds the limit")
            putInt(0, size)
            header[4] = kind.toByte()
        }

        private fun putInt(at: Int, value: Int) {
            for (i in 0 until 4) header[at + i] = (value ushr (24 - 8 * i)).toByte()
        }

        private fun putLong(at: Int, value: Long) {
            for (i in 0 until 8) header[at + i] = (value ushr (56 - 8 * i)).toByte()
        }
    }

    fun hello(name: String) = buildJsonObject {
        put("type", "hello")
        put("version", VERSION)
        put("name", name)
    }

    fun displays(displays: List<DisplayInfo>) = buildJsonObject {
        put("type", "displays")
        put("displays", buildJsonArray { displays.forEach { add(it.toJson()) } })
    }

    fun ended(stream: Int, error: DisplayError?) = buildJsonObject {
        put("type", "ended")
        put("stream", stream)
        if (error != null) put("error", error.toJson())
    }

    fun reply(id: Long, result: JsonElement?) = buildJsonObject {
        put("type", "reply")
        put("id", id)
        if (result != null) put("result", result)
    }

    fun reply(id: Long, error: DisplayError) = buildJsonObject {
        put("type", "reply")
        put("id", id)
        put("error", error.toJson())
    }
}

data class DisplayInfo(
    val id: String,
    val name: String,
    val width: Int,
    val height: Int,
    val stream: Boolean,
    val capture: Boolean,
    val input: Boolean,
    val system: List<String> = emptyList(),
    val tree: Boolean = false,
    val needs: List<String> = emptyList(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("name", name.take(200))
        put("width", width)
        put("height", height)
        put("stream", stream)
        put("capture", capture)
        put("input", input)
        if (system.isNotEmpty()) put("system", JsonArray(system.map(::JsonPrimitive)))
        if (tree) put("tree", true)
        if (needs.isNotEmpty()) put("needs", JsonArray(needs.map(::JsonPrimitive)))
    }
}

class DisplayError(val code: String, message: String) : Exception(message) {
    fun toJson(): JsonObject = buildJsonObject {
        put("code", code)
        put("message", message ?: code)
    }

    companion object {
        const val UNAVAILABLE = "unavailable"
        const val NOT_FOUND = "not_found"
        const val UNSUPPORTED = "unsupported"
        const val INVALID = "invalid"
        const val BUSY = "busy"
        const val FAILED = "failed"
    }
}
