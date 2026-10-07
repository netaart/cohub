package live.cohub.android.display

import android.content.Context
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class DisplayStatus(val sharedWith: String?, val control: Boolean, val error: String? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        put("sharedWith", sharedWith)
        put("control", control)
        put("error", error)
    }
}

class DeviceDisplay(private val context: Context, private val scope: CoroutineScope) {
    private class Share(val spaceId: String, val capture: ScreenCapture)

    private val share = MutableStateFlow<Share?>(null)
    private val failure = MutableStateFlow<String?>(null)
    private val resized = MutableStateFlow(0)
    /** Typed loosely: InputDriver needs Android 11, this class does not. */
    private var driver: Any? = null
    private val inputs = Mutex()

    val status: StateFlow<DisplayStatus> = combine(share, DisplayControl.service, failure) { current, control, error ->
        DisplayStatus(current?.spaceId, control != null, error)
    }.stateIn(scope, SharingStarted.Eagerly, DisplayStatus(null, DisplayControl.service.value != null))

    internal val changes: StateFlow<Any> = combine(share, DisplayControl.service, resized) { current, control, size ->
        Triple(current, control, size)
    }.stateIn(scope, SharingStarted.Eagerly, Unit)

    @RequiresApi(Build.VERSION_CODES.R)
    fun start(projection: MediaProjection, spaceId: String) {
        stop()
        failure.value = null
        val capture = try {
            ScreenCapture(context, projection, onStopped = { stopped(spaceId) }, onResized = { resized.value += 1 })
        } catch (error: Exception) {
            Log.w(TAG, "Screen sharing could not start", error)
            failure.value = "failed"
            projection.stop()
            return
        }
        share.value = Share(spaceId, capture)
    }

    fun stop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) share.value?.capture?.stop()
    }

    fun fail(code: String = "failed") {
        failure.value = code
    }

    suspend fun awaitShare(spaceId: String, request: () -> Unit): DisplayStatus {
        failure.value = null
        request()
        return withTimeout(SHARE_TIMEOUT_MS) { status.first { it.sharedWith == spaceId || it.error != null } }
    }

    private fun stopped(spaceId: String) {
        val current = share.value
        if (current?.spaceId == spaceId) share.value = null
    }

    @RequiresApi(Build.VERSION_CODES.R)
    internal fun displays(spaceId: String): List<DisplayInfo> {
        val current = share.value?.takeIf { it.spaceId == spaceId && it.capture.active } ?: return emptyList()
        val size = current.capture.size
        val control = DisplayControl.service.value != null
        val system = if (control) ControlService.GLOBAL_ACTIONS.keys.toList() else emptyList()
        val needs = if (control) emptyList() else listOf("accessibility")
        return listOf(DisplayInfo(SCREEN_ID, Build.MODEL ?: "Android", size.width, size.height, stream = true, capture = true, input = control, system = system, tree = control, needs = needs))
    }

    @RequiresApi(Build.VERSION_CODES.R)
    internal fun capture(spaceId: String, display: String): ScreenCapture {
        if (display != SCREEN_ID) throw DisplayError(DisplayError.NOT_FOUND, "display $display not found")
        return share.value?.takeIf { it.spaceId == spaceId && it.capture.active }?.capture
            ?: throw DisplayError(DisplayError.UNAVAILABLE, "the screen is not shared with this Space")
    }

    @RequiresApi(Build.VERSION_CODES.R)
    internal suspend fun input(spaceId: String, display: String, events: List<InputEvent>) {
        val capture = capture(spaceId, display)
        inputs.withLock { inputDriver().apply(events, capture.size.width, capture.size.height) }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    internal suspend fun tree(spaceId: String, display: String, maxElements: Int): JsonObject {
        val size = capture(spaceId, display).size
        val service = DisplayControl.service.value
            ?: throw DisplayError(DisplayError.UNAVAILABLE, "control is off; enable Cohub in Accessibility settings")
        return withContext(Dispatchers.Default) { inputDriver().elements.read(service, size.width, size.height, maxElements) }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun inputDriver(): InputDriver =
        driver as? InputDriver ?: InputDriver(scope) { share.value?.capture?.size?.densityDpi ?: context.resources.displayMetrics.densityDpi }.also { driver = it }

    companion object {
        const val SCREEN_ID = "screen"
        private const val SHARE_TIMEOUT_MS = 10_000L
        private const val TAG = "CohubDisplay"
    }
}
