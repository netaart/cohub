package live.cohub.android.runtime

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.random.Random

private const val TAG = "CohubBridge"

class SandboxBridge(
    private val binary: File,
    private val root: File,
    private val home: File,
    private val spaceId: String,
    private val relayUrl: String,
    private val runtimeId: String,
    private val token: suspend () -> String,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val registered = MutableStateFlow(false)

    /** True while the gateway has this bridge registered. */
    val connected: StateFlow<Boolean> = registered.asStateFlow()

    suspend fun run(ready: StateFlow<Boolean>): Nothing {
        var attempts = 0
        while (true) {
            ready.first { it }
            val startedAt = clock()
            runCatching { runOnce() }.onFailure { error ->
                if (error is CancellationException) throw error
                Log.w(TAG, "sandboxd failed to start", error)
            }
            if (clock() - startedAt > STABLE_MS) attempts = 0
            val backoff = (INITIAL_BACKOFF_MS shl attempts.coerceAtMost(6)).coerceAtMost(MAX_BACKOFF_MS)
            attempts++
            delay(backoff / 2 + Random.nextLong(backoff / 2 + 1))
        }
    }

    private suspend fun runOnce() = withContext(Dispatchers.IO) {
        val initial = token()
        val tmp = File(home, "tmp").apply { mkdirs() }
        val process = ProcessBuilder(
            binary.path, "--local", "--space", spaceId, "--root", root.path, "--relay", relayUrl,
        ).directory(root).apply {
            environment().putAll(
                mapOf(
                    "COHUB_RELAY_TOKEN" to initial,
                    "COHUB_RUNTIME_ID" to runtimeId,
                    "COHUB_RUNTIME_MANAGED" to "1",
                    "COHUB_RUNTIME_CONTROL_FD" to "2", // a JVM child inherits only the standard streams
                    "COHUB_LOG_FORMAT" to "json",
                    "HOME" to home.path,
                    "TMPDIR" to tmp.path,
                    // Other apps' private storage is unreadable, and thumbnails churn.
                    "FS_WATCH_IGNORE" to "Android/data,Android/obb,.thumbnails",
                ),
            )
        }.start()
        try {
            coroutineScope {
                launch { process.inputStream.bufferedReader().forEachLine { Log.i(TAG, it) } }
                launch {
                    process.errorStream.bufferedReader().forEachLine { line ->
                        when (controlEvent(line)) {
                            "connected" -> registered.value = true
                            "disconnected" -> registered.value = false
                            "hello" -> Unit
                            else -> Log.w(TAG, line)
                        }
                    }
                }
                launch {
                    val stdin = process.outputStream.bufferedWriter()
                    var current = initial
                    while (isActive) {
                        delay(TOKEN_REFRESH_MS)
                        val next = runCatching { token() }.getOrNull() ?: continue
                        if (next == current) continue
                        stdin.write(authFrame(next))
                        stdin.newLine()
                        stdin.flush()
                        current = next
                    }
                }
                try {
                    val code = runInterruptible { process.waitFor() }
                    Log.w(TAG, "sandboxd exited with $code")
                } finally {
                    // Ends the readers too: their pipes close with the process.
                    process.destroy()
                    if (!process.waitFor(STOP_GRACE_SECONDS, TimeUnit.SECONDS)) process.destroyForcibly()
                    coroutineContext.cancelChildren()
                }
            }
        } finally {
            registered.value = false
        }
    }

    internal companion object {
        const val INITIAL_BACKOFF_MS = 500L
        const val MAX_BACKOFF_MS = 30_000L
        const val STABLE_MS = 60_000L
        const val TOKEN_REFRESH_MS = 10_000L
        const val STOP_GRACE_SECONDS = 3L

        fun authFrame(token: String): String = buildJsonObject {
            put("type", "auth")
            put("token", token)
        }.toString()

        /** A managed control line (`{"type":"connected"}`), or null for anything else. */
        fun controlEvent(line: String): String? = RuntimeFrames.type(line)?.takeIf { it in CONTROL_EVENTS }

        private val CONTROL_EVENTS = setOf("hello", "connected", "disconnected")
    }
}
