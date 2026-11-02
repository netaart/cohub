package live.cohub.android.display

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import androidx.annotation.RequiresApi
import androidx.core.content.edit
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import live.cohub.android.R
import live.cohub.android.display.Indicator.Mode
import live.cohub.android.host.WebOrigin
import kotlin.math.abs

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
@SuppressLint("ClickableViewAccessibility")
internal class Overlay(private val service: ControlService, private val display: DeviceDisplay, scope: CoroutineScope) {
    private val windows = service.getSystemService(WindowManager::class.java)
    private val prefs = service.getSharedPreferences("indicator", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val root = FrameLayout(service)
    private val tab = EdgeTab(service)
    private val pill = Pill(service)
    private val panel = Panel(service)
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
        PixelFormat.TRANSLUCENT,
    )
    private val dim = Runnable { pill.animate().alpha(IDLE_ALPHA).setDuration(FADE_MS).start() }
    private var atLeft = prefs.getBoolean(LEFT, false)
    private var fromTop = prefs.getFloat(TOP, DEFAULT_TOP)
    private var shown: Pair<Served, Indicator>? = null
    private var open = false
    private var attached = false
    private val job: Job

    init {
        tab.setOnClickListener { setOpen(true) }
        pill.setOnClickListener { setOpen(true) }
        panel.setOnClickListener { setOpen(false) }
        panel.preview.setOnClickListener { openInCohub() }
        listOf(tab, pill, panel, panel.preview).forEach { it.setOnTouchListener(Dragger()) }
        root.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_OUTSIDE && open && shown?.second?.mode != Mode.ASKING) setOpen(false)
            false
        }
        job = scope.launch(Dispatchers.Main) {
            combine(display.changes, DisplayControl.foreground, display.page) { _, foreground, _ ->
                Indicator.pick(display.served().mapNotNull { served -> served.indicator()?.let { served to it } }, foreground == service.packageName, display.shownInCohub())
            }.distinctUntilChanged { a, b -> a?.first === b?.first && a?.second == b?.second }.collect(::render)
        }
    }

    private fun render(next: Pair<Served, Indicator>?) {
        val previous = shown
        shown = next
        if (next == null) return hide()
        val asking = next.second.mode == Mode.ASKING
        val wasAsking = previous?.takeIf { it.first === next.first }?.second?.mode == Mode.ASKING
        open = when {
            asking != wasAsking -> asking
            previous?.first !== next.first -> false
            else -> open
        }
        show()
    }

    private fun setOpen(value: Boolean) {
        open = value
        show()
    }

    fun refresh() = show()

    /** The page opens it in place; without one listening, Cohub opens at it. */
    private fun openInCohub() {
        val served = shown?.first ?: return
        setOpen(false)
        if (display.openInCohub(served)) return
        val url = WebOrigin.urlOf("/spaces/${served.spaceId}?window=display%3A${served.screen.id}")
        runCatching { service.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).setPackage(service.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    private fun show() {
        val (served, indicator) = shown ?: return
        val palette = Palette.of(service)
        val content = when {
            open -> panel.also { it.bind(look(indicator), palette, indicator.steps, actions(served, indicator.mode), served.screen.takeIf { indicator.preview != null }, maxPreview()) }
            indicator.mode == Mode.SHARING -> tab.also { it.side(atLeft) }
            else -> pill.also { it.bind(look(indicator), palette) }
        }
        val entering = content.parent !== root
        if (entering) {
            root.removeAllViews()
            root.addView(content)
        }
        place()
        awake()
        if (entering) enter(content)
    }

    private fun hide() {
        main.removeCallbacks(dim)
        open = false
        if (attached) runCatching { windows.removeView(root) }
        attached = false
        root.removeAllViews()
    }

    @SuppressLint("RtlHardcoded")
    private fun place() {
        val metrics = windows.currentWindowMetrics
        val bounds = metrics.bounds
        val insets = metrics.windowInsets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        root.measure(
            View.MeasureSpec.makeMeasureSpec(bounds.width(), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(bounds.height(), View.MeasureSpec.AT_MOST),
        )
        val minY = insets.top + root.dp(EDGE)
        val maxY = (bounds.height() - insets.bottom - root.measuredHeight - root.dp(EDGE)).coerceAtLeast(minY)
        params.gravity = Gravity.TOP or if (atLeft) Gravity.LEFT else Gravity.RIGHT
        params.x = (if (atLeft) insets.left else insets.right) + if (root.getChildAt(0) === tab) 0 else root.dp(EDGE)
        params.y = (fromTop * bounds.height()).toInt().coerceIn(minY, maxY)
        if (attached) windows.updateViewLayout(root, params) else runCatching { windows.addView(root, params) }.onSuccess { attached = true }
    }

    private fun enter(view: View) {
        view.pivotX = if (atLeft) 0f else root.measuredWidth.toFloat()
        view.pivotY = 0f
        view.alpha = 0f
        view.scaleX = ENTER_SCALE
        view.scaleY = ENTER_SCALE
        view.animate().alpha(1f).scaleX(1f).scaleY(1f).setInterpolator(DecelerateInterpolator()).setDuration(ENTER_MS).start()
    }

    private fun awake() {
        main.removeCallbacks(dim)
        pill.animate().cancel()
        pill.alpha = 1f
        if (pill.parent === root && shown?.second?.needsPerson == false) main.postDelayed(dim, IDLE_MS)
    }

    private fun look(indicator: Indicator) = when (indicator.mode) {
        Mode.HELD -> Look(Tone.WARNING, false, service.getString(if (indicator.label != null) R.string.overlay_done_hint else R.string.overlay_held))
        Mode.ASKING -> Look(Tone.WARNING, true, service.getString(R.string.overlay_activity, indicator.label))
        Mode.WORKING -> Look(Tone.ACCENT, true, indicator.label?.let { service.getString(R.string.overlay_activity, it) } ?: service.getString(R.string.overlay_working))
        Mode.SHARING -> Look(Tone.READY, false, service.getString(R.string.overlay_sharing))
    }

    /** The last action is the primary one. */
    private fun actions(served: Served, mode: Mode): List<Action> {
        val stop = Action(service.getString(R.string.overlay_stop)) { display.interrupt(served) }
        val takeOver = Action(service.getString(R.string.overlay_take_over)) {
            display.takeOver(served)
            setOpen(false)
        }
        return when (mode) {
            Mode.HELD -> listOf(Action(service.getString(R.string.overlay_hand_back)) { display.handBack(served) })
            Mode.ASKING -> listOf(stop, takeOver)
            Mode.WORKING -> listOf(takeOver, stop)
            Mode.SHARING -> listOf(Action(service.getString(R.string.overlay_stop_sharing)) { display.stop() })
        }
    }

    private fun maxPreview() = windows.currentWindowMetrics.bounds.height() * 3 / 5

    fun close() {
        job.cancel()
        hide()
    }

    private inner class Dragger : View.OnTouchListener {
        private val slop = ViewConfiguration.get(service).scaledTouchSlop
        private var downX = 0f
        private var downY = 0f
        private var fromY = 0
        private var dragging = false

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    fromY = params.y
                    dragging = false
                    awake()
                }
                MotionEvent.ACTION_MOVE -> {
                    if (!dragging && abs(event.rawX - downX) + abs(event.rawY - downY) > slop) dragging = true
                    if (dragging) move(event.rawX, fromY + (event.rawY - downY).toInt())
                }
                MotionEvent.ACTION_UP -> if (dragging) settle() else view.performClick()
                MotionEvent.ACTION_CANCEL -> if (dragging) settle()
            }
            return true
        }

        private fun move(rawX: Float, y: Int) {
            val bounds = windows.currentWindowMetrics.bounds
            val side = rawX < bounds.width() / 2f
            if (side != atLeft) {
                atLeft = side
                tab.side(atLeft)
            }
            fromTop = y.toFloat() / bounds.height()
            place()
            fromTop = params.y.toFloat() / bounds.height()
        }

        private fun settle() = prefs.edit { putBoolean(LEFT, atLeft).putFloat(TOP, fromTop) }
    }

    private companion object {
        const val LEFT = "left"
        const val TOP = "top"
        const val DEFAULT_TOP = 0.2f
        const val EDGE = 8
        const val IDLE_ALPHA = 0.72f
        const val IDLE_MS = 5_000L
        const val FADE_MS = 400L
        const val ENTER_SCALE = 0.92f
        const val ENTER_MS = 160L
    }
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
private fun Served.indicator() = Indicator.of(screen.agent, screen.size, activity, handover, held, recent)
