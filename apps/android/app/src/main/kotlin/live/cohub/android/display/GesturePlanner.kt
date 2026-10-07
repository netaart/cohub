package live.cohub.android.display

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlin.math.abs
import kotlin.math.hypot

sealed interface InputEvent {
    val at: Long?

    data class Pointer(val action: String, val x: Float, val y: Float, override val at: Long?) : InputEvent
    data class Scroll(val x: Float, val y: Float, val dx: Float, val dy: Float, override val at: Long?) : InputEvent
    data class Key(val action: String, val key: String, override val at: Long?) : InputEvent
    data class Text(val text: String, override val at: Long?) : InputEvent
    data class System(val action: String, override val at: Long?) : InputEvent

    companion object {
        fun parseAll(events: JsonArray): List<InputEvent> = events.map { parse(it as? JsonObject ?: invalid("event must be an object")) }

        private fun parse(event: JsonObject): InputEvent {
            fun string(key: String) = event[key]?.jsonPrimitive?.contentOrNull
            fun float(key: String) = event[key]?.jsonPrimitive?.floatOrNull
            fun unit(key: String) = float(key)?.takeIf { it in 0f..1f } ?: invalid("$key must be within 0..1")
            val at = event["t"]?.jsonPrimitive?.longOrNull
            val action = string("action")
            return when (string("type")) {
                "pointer" -> Pointer(action ?: invalid("pointer needs an action"), unit("x"), unit("y"), at)
                "scroll" -> Scroll(unit("x"), unit("y"), float("dx") ?: 0f, float("dy") ?: 0f, at)
                "key" -> Key(action ?: invalid("key needs an action"), string("key") ?: invalid("key is required"), at)
                "text" -> Text(string("text") ?: invalid("text is required"), at)
                "system" -> System(action ?: invalid("system needs an action"), at)
                else -> invalid("unknown event type")
            }
        }

        private fun invalid(message: String): Nothing = throw DisplayError(DisplayError.INVALID, message)
    }
}

data class Point(val x: Float, val y: Float)

data class StrokePlan(val points: List<Point>, val durationMs: Long)

sealed interface Step {
    val atMs: Long

    data class Gesture(override val atMs: Long, val stroke: StrokePlan) : Step
    data class Key(override val atMs: Long, val action: String, val key: String) : Step
    data class Text(override val atMs: Long, val text: String) : Step
    data class System(override val atMs: Long, val action: String) : Step
}

object GesturePlanner {
    const val MIN_TAP_MS = 40L
    const val SCROLL_MS = 350L
    const val MAX_GESTURE_MS = 60_000L

    fun point(x: Float, y: Float, width: Int, height: Int) =
        Point(x * (width - 1).coerceAtLeast(0), y * (height - 1).coerceAtLeast(0))

    fun isScheduled(events: List<InputEvent>) = events.any { it.at != null }

    fun scheduled(events: List<InputEvent>, width: Int, height: Int): List<Step> {
        val steps = mutableListOf<Step>()
        var time = 0L
        var stroke: MutableList<Point>? = null
        var strokeStart = 0L
        for (event in events) {
            time = event.at ?: time
            when (event) {
                is InputEvent.Pointer -> {
                    val point = point(event.x, event.y, width, height)
                    when (event.action) {
                        "down" -> {
                            if (stroke != null) throw DisplayError(DisplayError.INVALID, "pointer is already down")
                            stroke = mutableListOf(point)
                            strokeStart = time
                        }
                        "move" -> (stroke ?: throw DisplayError(DisplayError.INVALID, "pointer move before down")).add(point)
                        "up" -> {
                            val points = stroke ?: throw DisplayError(DisplayError.INVALID, "pointer up before down")
                            points.add(point)
                            val duration = (time - strokeStart).coerceIn(MIN_TAP_MS, MAX_GESTURE_MS)
                            steps.add(Step.Gesture(strokeStart, StrokePlan(points.dedupe(), duration)))
                            stroke = null
                        }
                        "cancel" -> stroke = null
                    }
                }
                is InputEvent.Scroll -> steps.add(Step.Gesture(time, scroll(event, width, height)))
                is InputEvent.Key -> steps.add(Step.Key(time, event.action, event.key))
                is InputEvent.Text -> steps.add(Step.Text(time, event.text))
                is InputEvent.System -> steps.add(Step.System(time, event.action))
            }
        }
        if (stroke != null) throw DisplayError(DisplayError.INVALID, "a scheduled pointer down needs an up")
        return steps
    }

    fun scroll(event: InputEvent.Scroll, width: Int, height: Int): StrokePlan {
        val start = point(event.x, event.y, width, height)
        val endX = (start.x - event.dx * width).coerceIn(0f, (width - 1).toFloat())
        val endY = (start.y - event.dy * height).coerceIn(0f, (height - 1).toFloat())
        return StrokePlan(listOf(start, Point(endX, endY)), SCROLL_MS)
    }

    private fun List<Point>.dedupe(): List<Point> =
        filterIndexed { index, point -> index == 0 || point != this[index - 1] }
}

interface StrokeSink {
    fun dispatch(stroke: StrokePlan, continuation: Boolean, willContinue: Boolean, done: (completed: Boolean) -> Unit)
}

class LivePointer(
    private val sink: StrokeSink,
    private val clock: () -> Long,
    private val schedule: (delayMs: Long, block: () -> Unit) -> () -> Unit,
    private val slopPx: Float,
    private val holdMs: Long = 200L,
) {
    private sealed interface State
    private data object Idle : State
    private class Buffering(val points: MutableList<Point>, val start: Long, var cancelTimer: () -> Unit) : State
    private class Live(var last: Point, var lastAt: Long) : State {
        var inFlight = false
        var ended = false
        val pending = mutableListOf<Point>()
    }

    private var state: State = Idle

    fun down(point: Point) {
        cancel()
        val buffering = Buffering(mutableListOf(point), clock()) {}
        buffering.cancelTimer = schedule(holdMs) { if (state === buffering) goLive(buffering) }
        state = buffering
    }

    fun move(point: Point) {
        when (val current = state) {
            is Buffering -> {
                current.points.add(point)
                val origin = current.points.first()
                if (hypot(point.x - origin.x, point.y - origin.y) > slopPx) goLive(current)
            }
            is Live -> {
                current.pending.add(point)
                flush(current)
            }
            Idle -> Unit
        }
    }

    fun up(point: Point) {
        when (val current = state) {
            is Buffering -> {
                current.cancelTimer()
                current.points.add(point)
                val duration = (clock() - current.start).coerceIn(GesturePlanner.MIN_TAP_MS, GesturePlanner.MAX_GESTURE_MS)
                state = Idle
                sink.dispatch(StrokePlan(current.points.distinctConsecutive(), duration), continuation = false, willContinue = false) {}
            }
            is Live -> {
                current.pending.add(point)
                current.ended = true
                flush(current)
            }
            Idle -> Unit
        }
    }

    fun cancel() {
        (state as? Buffering)?.cancelTimer?.invoke()
        val live = state as? Live
        state = Idle
        if (live != null && !live.ended && !live.inFlight) {
            sink.dispatch(StrokePlan(listOf(live.last), 1), continuation = true, willContinue = false) {}
        }
    }

    private fun goLive(buffering: Buffering) {
        buffering.cancelTimer()
        val now = clock()
        val live = Live(buffering.points.last(), now)
        state = live
        live.inFlight = true
        val first = StrokePlan(buffering.points.distinctConsecutive(), (now - buffering.start).coerceAtLeast(1))
        sink.dispatch(first, continuation = false, willContinue = true) { completed -> onDone(live, completed) }
    }

    private fun flush(live: Live) {
        if (live.inFlight || (live.pending.isEmpty() && !live.ended)) return
        val now = clock()
        val points = listOf(live.last) + live.pending
        live.pending.clear()
        live.inFlight = true
        val willContinue = !live.ended
        val segment = StrokePlan(points.distinctConsecutive(), (now - live.lastAt).coerceIn(1, GesturePlanner.MAX_GESTURE_MS))
        live.last = points.last()
        live.lastAt = now
        sink.dispatch(segment, continuation = true, willContinue = willContinue) { completed -> onDone(live, completed) }
    }

    private fun onDone(live: Live, completed: Boolean) {
        live.inFlight = false
        if (state !== live) return
        if (!completed || (live.ended && live.pending.isEmpty())) {
            state = Idle
            return
        }
        flush(live)
    }

    private fun List<Point>.distinctConsecutive(): List<Point> =
        filterIndexed { index, point -> index == 0 || abs(point.x - this[index - 1].x) + abs(point.y - this[index - 1].y) > 0f }
}
