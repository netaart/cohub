package live.cohub.android.runtime

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.random.Random

class RuntimeRejected(val code: String) : Exception(code) {
    companion object {
        const val SIGNED_OUT = "signed_out"
        const val FORBIDDEN = "forbidden"
        const val CONFLICT = "conflict"
    }
}

internal object RuntimeFrames {
    const val PROTOCOL_VERSION = 1

    fun hello(spaceId: String, token: String): String = buildJsonObject {
        put("type", "runtime.hello")
        put("version", PROTOCOL_VERSION)
        put("spaceId", spaceId)
        put("token", token)
        putJsonObject("capabilities") {
            put("harnesses", buildJsonArray {})
            put("models", buildJsonArray {})
        }
    }.toString()

    val heartbeat: String = buildJsonObject { put("type", "runtime.heartbeat") }.toString()

    fun auth(token: String): String = buildJsonObject {
        put("type", "runtime.auth")
        put("token", token)
    }.toString()

    fun type(text: String): String? = runCatching {
        (Json.parseToJsonElement(text) as? JsonObject)?.get("type")?.jsonPrimitive?.contentOrNull
    }.getOrNull()

    fun outcome(code: Int): Outcome = when (code) {
        4401 -> Outcome.UNAUTHORIZED
        4400, 4403 -> Outcome.REJECTED
        4409 -> Outcome.CONFLICT
        else -> Outcome.RETRY
    }

    enum class Outcome { RETRY, UNAUTHORIZED, CONFLICT, REJECTED }
}

class RuntimeConnection(
    private val client: OkHttpClient,
    private val url: String,
    private val spaceId: String,
    private val runtimeId: String,
    private val token: suspend (forceRefresh: Boolean) -> String,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val registered = MutableStateFlow(false)

    val ready: StateFlow<Boolean> = registered.asStateFlow()

    suspend fun run(): Nothing {
        var backoff = INITIAL_BACKOFF_MS
        var conflictSince: Long? = null
        var forceRefresh = false
        while (true) {
            val connectedAt = clock()
            val outcome = try {
                connectOnce(forceRefresh)
            } catch (error: CancellationException) {
                throw error
            } catch (error: RuntimeRejected) {
                throw error
            } catch (_: Exception) {
                RuntimeFrames.Outcome.RETRY
            }
            forceRefresh = outcome == RuntimeFrames.Outcome.UNAUTHORIZED
            when (outcome) {
                RuntimeFrames.Outcome.REJECTED -> throw RuntimeRejected(RuntimeRejected.FORBIDDEN)
                RuntimeFrames.Outcome.CONFLICT -> {
                    val since = conflictSince ?: clock().also { conflictSince = it }
                    if (clock() - since >= CONFLICT_TIMEOUT_MS) throw RuntimeRejected(RuntimeRejected.CONFLICT)
                }
                else -> conflictSince = null
            }
            if (clock() - connectedAt >= STABLE_MS) backoff = INITIAL_BACKOFF_MS
            delay(backoff / 2 + Random.nextLong(backoff / 2 + 1))
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    private suspend fun connectOnce(forceRefresh: Boolean): RuntimeFrames.Outcome = coroutineScope {
        val current = AtomicReference(token(forceRefresh))
        val events = Channel<Event>(Channel.UNLIMITED)
        val request = Request.Builder().url("$url?runtimeId=$runtimeId").build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                events.trySend(Event.Open)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                events.trySend(Event.Message(text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                events.trySend(Event.Closed(code))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                events.trySend(Event.Closed(response?.code ?: 0))
            }
        })
        val lastHeartbeat = AtomicLong(clock())
        val heartbeat = launch {
            while (isActive) {
                delay(HEARTBEAT_MS)
                if (clock() - lastHeartbeat.get() > HEARTBEAT_TIMEOUT_MS) {
                    socket.cancel()
                    events.trySend(Event.Closed(0))
                    break
                }
                if (!registered.value) continue
                socket.send(RuntimeFrames.heartbeat)
                val next = runCatching { token(false) }.getOrNull() ?: continue
                if (next != current.get() && socket.send(RuntimeFrames.auth(next))) current.set(next)
            }
        }
        try {
            for (event in events) {
                when (event) {
                    Event.Open -> socket.send(RuntimeFrames.hello(spaceId, current.get()))
                    is Event.Message -> when (RuntimeFrames.type(event.text)) {
                        "runtime.ready" -> {
                            lastHeartbeat.set(clock())
                            registered.value = true
                        }
                        "runtime.heartbeat" -> lastHeartbeat.set(clock())
                    }
                    is Event.Closed -> return@coroutineScope RuntimeFrames.outcome(event.code)
                }
            }
            RuntimeFrames.Outcome.RETRY
        } catch (error: CancellationException) {
            socket.close(1000, null)
            throw error
        } finally {
            registered.value = false
            heartbeat.cancel()
            socket.cancel()
        }
    }

    private sealed interface Event {
        data object Open : Event
        data class Message(val text: String) : Event
        data class Closed(val code: Int) : Event
    }

    private companion object {
        const val HEARTBEAT_MS = 10_000L
        const val HEARTBEAT_TIMEOUT_MS = 30_000L
        const val INITIAL_BACKOFF_MS = 500L
        const val MAX_BACKOFF_MS = 30_000L
        const val STABLE_MS = 60_000L
        const val CONFLICT_TIMEOUT_MS = 90_000L
    }
}
