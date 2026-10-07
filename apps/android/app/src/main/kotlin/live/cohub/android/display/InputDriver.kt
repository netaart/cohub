package live.cohub.android.display

import android.accessibilityservice.GestureDescription
import android.os.Build
import android.os.SystemClock
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@RequiresApi(Build.VERSION_CODES.R)
internal class InputDriver(private val scope: CoroutineScope, private val densityDpi: () -> Int) {
    private var previous: GestureDescription.StrokeDescription? = null

    private val sink = object : StrokeSink {
        override fun dispatch(stroke: StrokePlan, continuation: Boolean, willContinue: Boolean, done: (Boolean) -> Unit) {
            val service = DisplayControl.service.value as? ControlService
            val base = if (continuation) previous else null
            // A continuation whose stroke already ended would start a fresh tap.
            if (service == null || (continuation && base == null)) {
                previous = null
                done(false)
                return
            }
            service.stroke(stroke, base, willContinue) { description, completed ->
                previous = if (willContinue) description else null
                done(completed)
            }
        }
    }

    private val pointer by lazy {
        LivePointer(
            sink = sink,
            clock = SystemClock::uptimeMillis,
            schedule = { delayMs, block ->
                val job = scope.launch(Dispatchers.Main) { delay(delayMs); block() }
                val cancel: () -> Unit = { job.cancel() }
                cancel
            },
            slopPx = densityDpi() / 160f * TOUCH_SLOP_DP,
        )
    }

    suspend fun apply(events: List<InputEvent>, width: Int, height: Int) = withContext(Dispatchers.Main) {
        val service = DisplayControl.service.value as? ControlService
            ?: throw DisplayError(DisplayError.UNAVAILABLE, "control is off; enable Cohub in Accessibility settings")
        if (GesturePlanner.isScheduled(events)) runScheduled(service, GesturePlanner.scheduled(events, width, height))
        else events.forEach { live(service, it, width, height) }
    }

    private fun live(service: ControlService, event: InputEvent, width: Int, height: Int) {
        when (event) {
            is InputEvent.Pointer -> {
                val point = GesturePlanner.point(event.x, event.y, width, height)
                when (event.action) {
                    "down" -> pointer.down(point)
                    "move" -> pointer.move(point)
                    "up" -> pointer.up(point)
                    "cancel" -> pointer.cancel()
                }
            }
            is InputEvent.Scroll -> service.stroke(GesturePlanner.scroll(event, width, height), null, false) { _, _ -> }
            is InputEvent.Key -> if (event.action != "up") service.key(event.key)
            is InputEvent.Text -> service.type(event.text)
            is InputEvent.System -> service.system(event.action)
        }
    }

    private suspend fun runScheduled(service: ControlService, steps: List<Step>) {
        pointer.cancel()
        val start = SystemClock.uptimeMillis()
        for (step in steps.sortedBy { it.atMs }) {
            val wait = start + step.atMs - SystemClock.uptimeMillis()
            if (wait > 0) delay(wait)
            when (step) {
                is Step.Gesture -> {
                    val done = CompletableDeferred<Boolean>()
                    service.stroke(step.stroke, null, false) { _, completed -> done.complete(completed) }
                    if (!done.await()) throw DisplayError(DisplayError.FAILED, "the system cancelled a gesture")
                }
                is Step.Key -> if (step.action != "up") service.key(step.key)
                is Step.Text -> service.type(step.text)
                is Step.System -> service.system(step.action)
            }
        }
    }

    private companion object {
        const val TOUCH_SLOP_DP = 8f
    }
}
