package live.cohub.android.display

import android.accessibilityservice.AccessibilityService
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.annotation.RequiresApi
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import live.cohub.android.CohubApplication
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class ControlService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private val settled = Runnable { readFocus() }
    private var overlay: Overlay? = null

    override fun onServiceConnected() {
        DisplayControl.connected(this)
        val app = application as CohubApplication
        overlay = app.display?.let { Overlay(this, it, app.scope) }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        overlay?.refresh()
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        disconnect()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        main.removeCallbacks(settled)
        disconnect()
        super.onDestroy()
    }

    private fun disconnect() {
        overlay?.close()
        overlay = null
        DisplayControl.disconnected(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED || event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            DisplayControl.windowsChanged(event.displayId)
        }
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && event.isFullScreen && event.displayId == Display.DEFAULT_DISPLAY) {
            DisplayControl.foreground.value = event.packageName?.toString()
        }
        if (DisplayControl.followed.isEmpty()) return
        readFocus()
        main.removeCallbacks(settled)
        main.postDelayed(settled, FOCUS_SETTLE_MS)
    }

    internal fun refreshFocus() {
        main.post(settled)
    }

    private fun readFocus() {
        val all = windowsOnAllDisplays
        for (displayId in DisplayControl.followed.keys) {
            val windows = all[displayId].orEmpty()
            val typing = windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
            val node = if (typing) windows.firstNotNullOfOrNull { it.root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf(AccessibilityNodeInfo::isEditable) } else null
            DisplayControl.focusChanged(displayId, node?.let { FocusedField(Rect().also(it::getBoundsInScreen), it.isPassword) })
        }
    }

    override fun onInterrupt() = Unit

    private companion object {
        const val FOCUS_SETTLE_MS = 300L
    }
}

data class FocusedField(val bounds: Rect, val password: Boolean)

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
object DisplayControl {
    private val current = MutableStateFlow<ControlService?>(null)
    private val focused = MutableStateFlow<Map<Int, FocusedField>>(emptyMap())
    private val changes = MutableSharedFlow<Int>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    internal val followed = ConcurrentHashMap<Int, Int>()

    val service: StateFlow<ControlService?> = current.asStateFlow()

    val focus: StateFlow<Map<Int, FocusedField>> = focused.asStateFlow()

    val windows: SharedFlow<Int> = changes.asSharedFlow()

    val foreground = MutableStateFlow<String?>(null)

    internal fun followFocus(displayId: Int): () -> Unit {
        if (followed.merge(displayId, 1, Int::plus) == 1) current.value?.refreshFocus()
        val released = AtomicBoolean(false)
        return {
            if (released.compareAndSet(false, true) && followed.computeIfPresent(displayId) { _, count -> (count - 1).takeIf { it > 0 } } == null) {
                focused.update { it - displayId }
            }
        }
    }

    internal fun focusChanged(displayId: Int, value: FocusedField?) {
        focused.update { all ->
            when {
                !followed.containsKey(displayId) || value == null -> all - displayId
                else -> all + (displayId to value)
            }
        }
    }

    internal fun windowsChanged(displayId: Int) {
        changes.tryEmit(displayId)
    }

    internal fun connected(service: ControlService) {
        current.value = service
    }

    internal fun disconnected(service: ControlService) {
        if (current.value !== service) return
        current.value = null
        focused.value = emptyMap()
    }
}
