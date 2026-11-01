package live.cohub.android.display

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import live.cohub.android.helper.ICohubHelper

sealed interface InputEvent {
    val at: Long?

    data class Pointer(val action: String, val x: Float, val y: Float, override val at: Long?) : InputEvent
    data class Scroll(val x: Float, val y: Float, val dx: Float, val dy: Float, override val at: Long?) : InputEvent
    data class Key(val action: String, val key: String, override val at: Long?) : InputEvent
    data class Text(val text: String, override val at: Long?) : InputEvent
    data class System(val action: String, override val at: Long?) : InputEvent
    data class Element(val ref: String, val action: String, val text: String?, override val at: Long?) : InputEvent

    companion object {
        fun parseAll(events: JsonArray): List<InputEvent> = events.map { parse(it as? JsonObject ?: invalid("event must be an object")) }

        private fun parse(event: JsonObject): InputEvent {
            fun string(key: String) = event[key]?.jsonPrimitive?.contentOrNull
            fun float(key: String) = event[key]?.jsonPrimitive?.floatOrNull
            fun unit(key: String) = float(key)?.takeIf { it in 0f..1f } ?: invalid("$key must be within 0..1")
            val at = event["t"]?.jsonPrimitive?.longOrNull
            val action = string("action")
            if (string("button")?.let { it != "primary" } == true) throw DisplayError(DisplayError.UNSUPPORTED, "a phone takes taps, not other buttons")
            return when (string("type")) {
                "pointer" -> Pointer(action ?: invalid("pointer needs an action"), unit("x"), unit("y"), at)
                "scroll" -> Scroll(unit("x"), unit("y"), float("dx") ?: 0f, float("dy") ?: 0f, at)
                "key" -> Key(action ?: invalid("key needs an action"), string("key") ?: invalid("key is required"), at)
                "text" -> Text(string("text") ?: invalid("text is required"), at)
                "system" -> System(action ?: invalid("system needs an action"), at)
                "element" -> Element(string("ref") ?: invalid("element needs a ref"), action ?: invalid("element needs an action"), string("text"), at)
                else -> invalid("unknown event type")
            }
        }

        private fun invalid(message: String): Nothing = throw DisplayError(DisplayError.INVALID, message)
    }
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class InputDriver(
    private val helper: ICohubHelper,
    private val screen: Screen,
    private val elements: ElementTree,
    private val service: () -> AccessibilityService?,
) {
    private var downTime = 0L
    private var finger: FloatArray? = null
    private var meta = 0
    private val held = mutableSetOf<Int>()

    suspend fun apply(events: List<InputEvent>) {
        try {
            if (events.any { it.at != null }) scheduled(events) else events.forEach { perform(it) }
        } catch (error: Throwable) {
            release()
            throw error
        }
    }

    private suspend fun scheduled(events: List<InputEvent>) {
        val start = SystemClock.uptimeMillis()
        var last = 0L
        for (event in events.sortedBy { it.at ?: 0L }) {
            val at = event.at ?: last
            val from = finger
            if (event is InputEvent.Pointer && from != null && event.action != "cancel") {
                glide(from, point(event.x, event.y), start + last, start + at)
            } else {
                delay(start + at - SystemClock.uptimeMillis())
            }
            perform(event)
            last = at
        }
    }

    private suspend fun glide(from: FloatArray, to: FloatArray, since: Long, until: Long) {
        val steps = ((until - since) / FRAME_MS).toInt()
        if (steps > 1 && !from.contentEquals(to)) {
            for (step in 1 until steps) {
                delay(since + step * FRAME_MS - SystemClock.uptimeMillis())
                val f = step.toFloat() / steps
                touch(MotionEvent.ACTION_MOVE, from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f)
            }
        }
        delay(until - SystemClock.uptimeMillis())
    }

    private suspend fun perform(event: InputEvent) {
        when (event) {
            is InputEvent.Pointer -> {
                val (x, y) = point(event.x, event.y)
                when (event.action) {
                    "down" -> {
                        downTime = SystemClock.uptimeMillis()
                        touch(MotionEvent.ACTION_DOWN, x, y)
                    }
                    "move" -> if (finger != null) touch(MotionEvent.ACTION_MOVE, x, y)
                    "up" -> if (finger != null) touch(MotionEvent.ACTION_UP, x, y)
                    "cancel" -> release()
                }
            }
            is InputEvent.Scroll -> scroll(event)
            is InputEvent.Key -> key(event.action, event.key)
            is InputEvent.Text -> type(event.text)
            is InputEvent.System -> system(event.action)
            is InputEvent.Element -> elements.perform(this, event.ref, event.action, event.text)
        }
    }

    private fun point(x: Float, y: Float) = floatArrayOf(x * (screen.size.width - 1).coerceAtLeast(0), y * (screen.size.height - 1).coerceAtLeast(0))

    private fun touch(action: Int, x: Float, y: Float) {
        if (!helper.touch(screen.displayId, action, x, y, downTime)) throw DisplayError(DisplayError.FAILED, "the phone refused the touch")
        finger = if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) null else floatArrayOf(x, y)
    }

    fun press(x: Float, y: Float, durationMs: Long) {
        downTime = SystemClock.uptimeMillis()
        touch(MotionEvent.ACTION_DOWN, x, y)
        SystemClock.sleep(durationMs)
        touch(MotionEvent.ACTION_UP, x, y)
    }

    private suspend fun scroll(event: InputEvent.Scroll) {
        val from = point(event.x, event.y)
        val width = screen.size.width.toFloat()
        val height = screen.size.height.toFloat()
        val to = floatArrayOf((from[0] - event.dx * width).coerceIn(0f, width - 1), (from[1] - event.dy * height).coerceIn(0f, height - 1))
        downTime = SystemClock.uptimeMillis()
        touch(MotionEvent.ACTION_DOWN, from[0], from[1])
        glide(from, to, downTime, downTime + SCROLL_MS)
        touch(MotionEvent.ACTION_MOVE, to[0], to[1])
        delay(SCROLL_HOLD_MS)
        touch(MotionEvent.ACTION_UP, to[0], to[1])
    }

    private fun key(action: String, name: String) {
        val code = KEYS[name] ?: MODIFIERS[name]?.first
        if (code == null) {
            if (action == "up") return
            val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(name.toCharArray())
                ?: throw DisplayError(DisplayError.UNSUPPORTED, "key $name is not supported on Android")
            events.forEach { send(it.action, it.keyCode, it.metaState or meta) }
            return
        }
        val modifier = MODIFIERS[name]?.second
        if (action != "up") {
            if (modifier != null) meta = meta or modifier
            send(KeyEvent.ACTION_DOWN, code, meta)
            held += code
        }
        if (action != "down") {
            send(KeyEvent.ACTION_UP, code, meta)
            held -= code
            if (modifier != null) meta = meta and modifier.inv()
        }
    }

    private fun send(action: Int, code: Int, metaState: Int) {
        if (!helper.key(screen.displayId, action, code, metaState)) throw DisplayError(DisplayError.FAILED, "the phone refused the key")
    }

    private fun type(text: String) {
        val node = service()?.let { elements.focused(it, screen.displayId) }
        if (node != null) return insert(node, text)
        val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray())
            ?: throw DisplayError(DisplayError.UNAVAILABLE, "no text field is focused")
        events.forEach { send(it.action, it.keyCode, it.metaState) }
    }

    private fun insert(node: AccessibilityNodeInfo, text: String) {
        val current = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
        val start = node.textSelectionStart.takeIf { it in 0..current.length } ?: current.length
        val end = node.textSelectionEnd.takeIf { it in start..current.length } ?: start
        val next = current.substring(0, start) + text + current.substring(end)
        val set = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
        })
        if (!set) throw DisplayError(DisplayError.FAILED, "the focused field refused text")
        val cursor = start + text.length
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        })
    }

    private fun system(action: String) {
        SYSTEM_KEYS[action]?.let { code ->
            send(KeyEvent.ACTION_DOWN, code, 0)
            send(KeyEvent.ACTION_UP, code, 0)
            return
        }
        val global = GLOBAL_ACTIONS[action]?.takeIf { !screen.agent }
            ?: throw DisplayError(DisplayError.UNSUPPORTED, "this display has no $action button")
        val current = service() ?: throw DisplayError(DisplayError.UNAVAILABLE, "control is off; enable Cohub in Accessibility settings")
        if (!current.performGlobalAction(global)) throw DisplayError(DisplayError.FAILED, "the system refused $action")
    }

    fun release() {
        finger?.let { (x, y) -> runCatching { touch(MotionEvent.ACTION_CANCEL, x, y) } }
        finger = null
        held.toList().forEach { runCatching { send(KeyEvent.ACTION_UP, it, 0) } }
        held.clear()
        meta = 0
    }

    companion object {
        private const val FRAME_MS = 8L
        private const val SCROLL_MS = 300L
        private const val SCROLL_HOLD_MS = 120L

        fun systemButtons(agent: Boolean): List<String> = if (agent) listOf("back") else (SYSTEM_KEYS.keys + GLOBAL_ACTIONS.keys).toList()

        private val SYSTEM_KEYS = linkedMapOf("back" to KeyEvent.KEYCODE_BACK, "home" to KeyEvent.KEYCODE_HOME, "recents" to KeyEvent.KEYCODE_APP_SWITCH)
        private val GLOBAL_ACTIONS = linkedMapOf(
            "notifications" to AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS,
            "quickSettings" to AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS,
            "lock" to AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN,
        )
        private val MODIFIERS = mapOf(
            "Control" to (KeyEvent.KEYCODE_CTRL_LEFT to (KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)),
            "Shift" to (KeyEvent.KEYCODE_SHIFT_LEFT to (KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON)),
            "Alt" to (KeyEvent.KEYCODE_ALT_LEFT to (KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON)),
            "Meta" to (KeyEvent.KEYCODE_META_LEFT to (KeyEvent.META_META_ON or KeyEvent.META_META_LEFT_ON)),
        )
        private val KEYS = mapOf(
            "Enter" to KeyEvent.KEYCODE_ENTER, "Tab" to KeyEvent.KEYCODE_TAB, "Backspace" to KeyEvent.KEYCODE_DEL,
            "Delete" to KeyEvent.KEYCODE_FORWARD_DEL, "Escape" to KeyEvent.KEYCODE_ESCAPE, " " to KeyEvent.KEYCODE_SPACE,
            "ArrowUp" to KeyEvent.KEYCODE_DPAD_UP, "ArrowDown" to KeyEvent.KEYCODE_DPAD_DOWN,
            "ArrowLeft" to KeyEvent.KEYCODE_DPAD_LEFT, "ArrowRight" to KeyEvent.KEYCODE_DPAD_RIGHT,
            "Home" to KeyEvent.KEYCODE_MOVE_HOME, "End" to KeyEvent.KEYCODE_MOVE_END,
            "PageUp" to KeyEvent.KEYCODE_PAGE_UP, "PageDown" to KeyEvent.KEYCODE_PAGE_DOWN,
            "GoBack" to KeyEvent.KEYCODE_BACK, "BrowserBack" to KeyEvent.KEYCODE_BACK,
        ) + (1..12).associate { "F$it" to KeyEvent.KEYCODE_F1 + it - 1 }
    }
}
