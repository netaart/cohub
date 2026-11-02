package live.cohub.android.display

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.accessibilityservice.GestureDescription.StrokeDescription
import android.content.ClipData
import android.graphics.Path
import android.graphics.PointF
import android.icu.text.BreakIterator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import kotlin.math.hypot

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class GestureInjector(private val service: () -> AccessibilityService?, private val slop: Float) : Injector {
    private class Stroke(val origin: PointF, var lastAt: Long) {
        var pending = mutableListOf(origin)
        var last: PointF? = null
        var sent: StrokeDescription? = null
        var inFlight = false
        var ended = false
    }

    private val main = Handler(Looper.getMainLooper())
    private var stroke: Stroke? = null
    private val rest = Runnable { synchronized(this) { stroke?.takeIf { it.last == null && !it.ended }?.let(::flush) } }

    @Synchronized
    override fun touch(action: Int, x: Float, y: Float, downTime: Long) {
        val point = PointF(x, y)
        when (action) {
            MotionEvent.ACTION_DOWN -> {
                requireService()
                lift()
                stroke = Stroke(point, SystemClock.uptimeMillis())
                main.postDelayed(rest, REST_MS)
            }
            MotionEvent.ACTION_MOVE -> stroke?.let {
                it.pending += point
                if (it.last != null || hypot(point.x - it.origin.x, point.y - it.origin.y) > slop) send(it)
            }
            MotionEvent.ACTION_UP -> stroke?.let {
                it.pending += point
                it.ended = true
                send(it)
            }
            MotionEvent.ACTION_CANCEL -> lift()
        }
    }

    private fun send(stroke: Stroke) {
        if (!flush(stroke)) throw DisplayError(DisplayError.FAILED, "the phone dropped the gesture")
    }

    private fun flush(stroke: Stroke): Boolean {
        main.removeCallbacks(rest)
        val from = stroke.last
        if (stroke.inFlight || (from != null && stroke.pending.isEmpty() && !stroke.ended)) return true
        val points = listOfNotNull(from) + stroke.pending
        stroke.pending = mutableListOf()
        val now = SystemClock.uptimeMillis()
        val path = Path().apply {
            moveTo(points[0].x, points[0].y)
            for (point in points.drop(1)) lineTo(point.x, point.y)
        }
        val duration = (now - stroke.lastAt).coerceIn(if (stroke.sent == null) TAP_MS else 1, MAX_STROKE_MS)
        stroke.last = points.last()
        stroke.lastAt = now
        val dispatched = try {
            val next = stroke.sent?.continueStroke(path, 0, duration, !stroke.ended) ?: StrokeDescription(path, 0, duration, !stroke.ended)
            val callback = object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gesture: GestureDescription?) = done(stroke, next, completed = true)
                override fun onCancelled(gesture: GestureDescription?) = done(stroke, next, completed = false)
            }
            service()?.dispatchGesture(GestureDescription.Builder().addStroke(next).build(), callback, main) == true
        } catch (_: RuntimeException) {
            false
        }
        stroke.inFlight = dispatched
        if (!dispatched && this.stroke === stroke) this.stroke = null
        return dispatched
    }

    @Synchronized
    private fun done(stroke: Stroke, sent: StrokeDescription, completed: Boolean) {
        stroke.inFlight = false
        stroke.sent = sent
        when {
            !completed || !sent.willContinue() -> if (this.stroke === stroke) this.stroke = null
            this.stroke !== stroke -> raise(stroke)
            stroke.pending.isNotEmpty() || stroke.ended -> flush(stroke)
        }
    }

    private fun lift() {
        main.removeCallbacks(rest)
        val current = stroke ?: return
        stroke = null
        if (!current.inFlight) raise(current)
    }

    private fun raise(stroke: Stroke) {
        val sent = stroke.sent?.takeIf { it.willContinue() } ?: return
        val at = stroke.last ?: return
        val path = Path().apply { moveTo(at.x, at.y) }
        runCatching { service()?.dispatchGesture(GestureDescription.Builder().addStroke(sent.continueStroke(path, 0, 1, false)).build(), null, null) }
    }

    override fun key(action: Int, code: Int, metaState: Int) {
        if (action != KeyEvent.ACTION_DOWN || KeyEvent.isModifierKey(code)) return
        when (code) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> global(AccessibilityService.GLOBAL_ACTION_BACK)
            KeyEvent.KEYCODE_HOME -> global(AccessibilityService.GLOBAL_ACTION_HOME)
            KeyEvent.KEYCODE_APP_SWITCH -> global(AccessibilityService.GLOBAL_ACTION_RECENTS)
            KeyEvent.KEYCODE_ENTER -> {
                if (!focused().performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) insert("\n")
            }
            KeyEvent.KEYCODE_DEL -> edit { text, start, end ->
                val from = if (start != end) start else characters(text).preceding(start).coerceAtLeast(0)
                text.removeRange(from, end) to from
            }
            KeyEvent.KEYCODE_FORWARD_DEL -> edit { text, start, end ->
                val to = if (start != end) end else characters(text).following(end).takeIf { it != BreakIterator.DONE } ?: text.length
                text.removeRange(start, to) to start
            }
            else -> {
                val char = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).get(code, metaState)
                if (char < ' '.code || metaState and CHORDS != 0) throw DisplayError(DisplayError.UNSUPPORTED, "this key needs phone control")
                insert(String(Character.toChars(char)))
            }
        }
    }

    override fun putClip(text: String): ClipData? = throw DisplayError(DisplayError.UNSUPPORTED, "this field takes text only with phone control")

    override fun restoreClip(previous: ClipData?, text: String) = Unit

    private fun requireService() = service() ?: throw DisplayError(DisplayError.UNAVAILABLE, "control is off; enable Cohub in Accessibility settings")

    private fun global(action: Int) {
        if (!requireService().performGlobalAction(action)) throw DisplayError(DisplayError.FAILED, "the system refused the key")
    }

    private fun focused(): AccessibilityNodeInfo =
        requireService().findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.refresh() && it.isEditable }
            ?: throw DisplayError(DisplayError.UNAVAILABLE, "no text field is focused")

    private fun insert(text: String) = edit { current, start, end -> current.substring(0, start) + text + current.substring(end) to start + text.length }

    private fun edit(change: (text: String, start: Int, end: Int) -> Pair<String, Int>) {
        val node = focused()
        if (node.isPassword) throw DisplayError(DisplayError.UNSUPPORTED, "a password field takes keys only with phone control")
        val current = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
        val start = node.textSelectionStart.takeIf { it in 0..current.length } ?: current.length
        val end = node.textSelectionEnd.takeIf { it in start..current.length } ?: start
        val (next, cursor) = change(current, start, end)
        val set = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
        })
        if (!set) throw DisplayError(DisplayError.FAILED, "the focused field refused text")
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        })
    }

    private fun characters(text: String) = BreakIterator.getCharacterInstance().apply { setText(text) }

    private companion object {
        const val REST_MS = 200L
        const val TAP_MS = 40L
        const val MAX_STROKE_MS = 60_000L
        const val CHORDS = KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON or KeyEvent.META_META_ON
    }
}
