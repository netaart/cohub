package live.cohub.android.host

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class BridgeRequest(val id: String, val method: String, val params: JsonElement?) {
    val fields: JsonObject get() = params as? JsonObject ?: EMPTY

    companion object {
        private const val MAX_TEXT = 32 * 1024 * 1024
        private val EMPTY = JsonObject(emptyMap())

        fun parse(text: String): BridgeRequest? {
            if (text.length > MAX_TEXT) return null
            val message = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
            if (message.string("type") != "request") return null
            val id = message.string("id")?.takeIf { it.codePointCount(0, it.length) in 1..128 } ?: return null
            val method = message.string("method")?.takeIf { it.codePointCount(0, it.length) in 1..64 } ?: return null
            return BridgeRequest(id, method, message["params"])
        }

        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

object BridgeMessages {
    private const val MAX_ERROR = 2_000

    fun result(id: String, result: JsonElement): String = buildJsonObject {
        put("type", "response")
        put("id", id)
        put("result", result)
    }.toString()

    fun error(id: String, code: String, message: String): String = buildJsonObject {
        put("type", "response")
        put("id", id)
        put(
            "error",
            buildJsonObject {
                put("code", code)
                put("message", message.ifEmpty { "Host call failed" }.take(MAX_ERROR))
            },
        )
    }.toString()

    fun event(name: String, payload: JsonElement?): String = buildJsonObject {
        put("type", "event")
        put("name", name)
        if (payload != null) put("payload", payload)
    }.toString()
}
