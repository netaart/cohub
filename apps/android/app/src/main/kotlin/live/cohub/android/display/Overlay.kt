package live.cohub.android.display

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.RequiresApi
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import live.cohub.android.R
import kotlin.math.abs

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
@SuppressLint("ClickableViewAccessibility")
internal class Overlay(private val service: ControlService, private val display: DeviceDisplay, scope: CoroutineScope) {
    private val windows = service.getSystemService(WindowManager::class.java)
    private val density = service.resources.displayMetrics.density
    private val prefs = service.getSharedPreferences("overlay", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val root = FrameLayout(service)
    private val card = LinearLayout(service).apply {
        orientation = LinearLayout.VERTICAL
        elevation = dp(8)
        setPadding(dp(12).toInt(), dp(10).toInt(), dp(12).toInt(), dp(10).toInt())
    }
    private val dot = View(service).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL } }
    private val label = TextView(service).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
    }
    private val recent = TextView(service).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setLineSpacing(dp(2), 1f)
    }
    private val preview = SurfaceView(service)
    private val actions = LinearLayout(service).apply { gravity = Gravity.END }
    private val primary = button()
    private val secondary = button()
    private val pulse = ObjectAnimator.ofFloat(dot, View.ALPHA, 1f, 0.3f).apply {
        duration = 900
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
    }
    private val dim = Runnable { if (!open) card.animate().alpha(IDLE_ALPHA).setDuration(FADE_MS).start() }
    private var shown: Served? = null
    private var asked = false
    private var open = false
    private var attached = false
    private var mirror: IBinder? = null
    private var x = prefs.getInt(X, -1)
    private var y = prefs.getInt(Y, -1)
    private val job: Job

    init {
        val header = LinearLayout(service).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(dot, LinearLayout.LayoutParams(dp(8).toInt(), dp(8).toInt()).apply { marginEnd = dp(8).toInt() })
            addView(label, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        val block = { top: Int -> LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top).toInt() } }
        card.addView(header)
        card.addView(recent, block(8))
        card.addView(preview, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0).apply { topMargin = dp(10).toInt() })
        actions.addView(secondary)
        actions.addView(primary)
        card.addView(actions, block(8))
        root.addView(card, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        card.setOnClickListener { setOpen(!open) }
        card.setOnTouchListener(Dragger())
        root.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_OUTSIDE && !asked) setOpen(false)
            false
        }
        preview.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) = Unit
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                unmirror()
                mirror = runCatching { shown?.screen?.mirror(holder.surface, width, height) }.getOrNull()
            }
            override fun surfaceDestroyed(holder: SurfaceHolder) = unmirror()
        })
        job = scope.launch(Dispatchers.Main) {
            combine(display.changes, display.status, DisplayControl.foreground) { _, _, _ -> }.collect { render(display.served()) }
        }
    }

    private fun render(all: List<Served>) {
        val next = all.firstOrNull { it.held } ?: all.firstOrNull { it.handover != null } ?: all.firstOrNull { it.activity != null } ?: all.firstOrNull { !it.screen.agent }
        val needsPerson = next != null && (next.held || next.handover != null)
        if (next == null || !needsPerson && DisplayControl.foreground.value == service.packageName) return detach()
        if (next !== shown) {
            shown = next
            setOpen(false)
        }
        val palette = palette()
        val ask = next.handover
        val (color, text) = when {
            next.held -> WARNING to service.getString(if (ask != null) R.string.overlay_done_hint else R.string.overlay_held)
            ask != null -> WARNING to service.getString(R.string.overlay_activity, ask.reason)
            next.activity != null -> ACCENT to (next.activity?.label?.let { service.getString(R.string.overlay_activity, it) } ?: service.getString(R.string.overlay_working))
            else -> READY to service.getString(R.string.overlay_sharing)
        }
        card.background = rounded(palette.surface, 18f)
        label.setTextColor(palette.text)
        recent.setTextColor(palette.secondary)
        (dot.background as GradientDrawable).setColor(color)
        label.text = text
        recent.text = next.recent.dropLast(1).joinToString("\n")
        if ((next.activity != null || ask != null) && !next.held) pulse.start() else {
            pulse.end()
            dot.alpha = 1f
        }
        style(primary, palette, ACCENT)
        style(secondary, palette, palette.text)
        primary.text = service.getString(when {
            next.held -> R.string.overlay_hand_back
            ask != null -> R.string.overlay_take_over
            next.activity != null -> R.string.overlay_stop
            else -> R.string.overlay_stop_sharing
        })
        primary.setOnClickListener {
            when {
                next.held -> display.handBack(next)
                ask != null -> display.takeOver(next)
                next.activity != null -> display.interrupt(next)
                else -> display.stop()
            }
        }
        secondary.visibility = if (!next.held && (next.activity != null || ask != null)) View.VISIBLE else View.GONE
        secondary.text = service.getString(if (ask != null) R.string.overlay_stop else R.string.overlay_take_over)
        secondary.setOnClickListener {
            if (ask != null) display.interrupt(next) else {
                display.takeOver(next)
                setOpen(false)
            }
        }
        attach()
        val asking = ask != null
        if (asking != asked) {
            asked = asking
            setOpen(asking)
        } else if (open) {
            layoutPreview()
        }
        awake()
    }

    private fun setOpen(value: Boolean) {
        open = value
        layoutPreview()
        actions.visibility = if (open) View.VISIBLE else View.GONE
        label.maxWidth = dp(if (open) PREVIEW_WIDTH else PILL_WIDTH).toInt()
        card.layoutParams = (card.layoutParams as FrameLayout.LayoutParams).apply {
            width = if (open) dp(PREVIEW_WIDTH + 24).toInt() else FrameLayout.LayoutParams.WRAP_CONTENT
        }
        if (attached) {
            windows.updateViewLayout(root, params())
            card.scaleX = OPEN_SCALE
            card.scaleY = OPEN_SCALE
            card.animate().scaleX(1f).scaleY(1f).setInterpolator(DecelerateInterpolator()).setDuration(OPEN_MS).start()
        }
        awake()
    }

    private fun layoutPreview() {
        val served = shown
        val live = open && served != null && served.screen.agent && !served.held
        recent.visibility = if (open && recent.text.isNotEmpty()) View.VISIBLE else View.GONE
        val height = if (live) (dp(PREVIEW_WIDTH) * served!!.screen.size.height / served.screen.size.width).toInt().coerceAtMost(maxPreviewHeight()) else 0
        if (!live) unmirror()
        val params = preview.layoutParams as LinearLayout.LayoutParams
        if (params.height != height) {
            params.height = height
            preview.layoutParams = params
        }
    }

    private fun maxPreviewHeight() = windows.currentWindowMetrics.bounds.height() * 3 / 5

    private fun awake() {
        main.removeCallbacks(dim)
        card.animate().cancel()
        card.alpha = 1f
        if (!open && shown?.held != true && shown?.handover == null) main.postDelayed(dim, IDLE_MS)
    }

    private fun attach() {
        if (attached) return
        runCatching { windows.addView(root, params()) }.onSuccess { attached = true }
    }

    private fun detach() {
        unmirror()
        main.removeCallbacks(dim)
        shown = null
        asked = false
        open = false
        pulse.end()
        if (attached) runCatching { windows.removeView(root) }
        attached = false
    }

    private fun unmirror() {
        mirror?.let { token -> shown?.screen?.unmirror(token) }
        mirror = null
    }

    private fun params() = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        val bounds = windows.currentWindowMetrics.bounds
        val top = windows.currentWindowMetrics.windowInsets.getInsets(WindowInsets.Type.statusBars()).top + dp(8).toInt()
        root.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        val width = root.measuredWidth
        val rightSide = bounds.width() - width - dp(EDGE).toInt()
        val savedX = this@Overlay.x
        val savedY = this@Overlay.y
        x = if (savedX < 0 || savedX > bounds.width() / 2) rightSide else savedX
        y = if (savedY < 0) top else savedY.coerceIn(top, (bounds.height() - dp(120).toInt()).coerceAtLeast(top))
    }

    fun close() {
        job.cancel()
        detach()
    }

    private inner class Dragger : View.OnTouchListener {
        private val slop = ViewConfiguration.get(service).scaledTouchSlop
        private var startX = 0f
        private var startY = 0f
        private var fromX = 0
        private var fromY = 0
        private var dragging = false

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val params = root.layoutParams as WindowManager.LayoutParams
                    startX = event.rawX
                    startY = event.rawY
                    fromX = params.x
                    fromY = params.y
                    dragging = false
                    awake()
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startX
                    val dy = event.rawY - startY
                    if (!dragging && abs(dx) + abs(dy) > slop) dragging = true
                    if (dragging && attached) {
                        val params = root.layoutParams as WindowManager.LayoutParams
                        params.x = fromX + dx.toInt()
                        params.y = fromY + dy.toInt()
                        windows.updateViewLayout(root, params)
                    }
                }
                MotionEvent.ACTION_UP -> if (dragging) settle() else view.performClick()
                MotionEvent.ACTION_CANCEL -> if (dragging) settle()
            }
            return true
        }

        private fun settle() {
            val params = root.layoutParams as WindowManager.LayoutParams
            val width = windows.currentWindowMetrics.bounds.width()
            val end = if (params.x + root.width / 2 < width / 2) dp(EDGE).toInt() else width - root.width - dp(EDGE).toInt()
            y = params.y
            x = end
            prefs.edit { putInt(X, x).putInt(Y, y) }
            ValueAnimator.ofInt(params.x, end).apply {
                duration = SNAP_MS
                interpolator = DecelerateInterpolator()
                addUpdateListener {
                    if (!attached) return@addUpdateListener
                    params.x = it.animatedValue as Int
                    windows.updateViewLayout(root, params)
                }
            }.start()
        }
    }

    private class Palette(val surface: Int, val text: Int, val secondary: Int, val button: Int)

    private fun palette(): Palette {
        val night = service.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        return if (night) {
            Palette(Color.argb(240, 28, 28, 30), Color.WHITE, Color.argb(170, 255, 255, 255), Color.argb(40, 255, 255, 255))
        } else {
            Palette(Color.argb(245, 255, 255, 255), Color.rgb(28, 28, 30), Color.argb(150, 28, 28, 30), Color.argb(20, 0, 0, 0))
        }
    }

    private fun button() = TextView(service).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setPadding(dp(12).toInt(), dp(8).toInt(), dp(12).toInt(), dp(8).toInt())
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8).toInt() }
    }

    private fun style(view: TextView, palette: Palette, color: Int) {
        view.setTextColor(color)
        view.background = rounded(palette.button, 12f)
    }

    private fun rounded(color: Int, radius: Float) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius)
    }

    private fun dp(value: Number) = value.toFloat() * density

    private companion object {
        const val X = "x"
        const val Y = "y"
        const val EDGE = 12
        const val PILL_WIDTH = 200
        const val PREVIEW_WIDTH = 180
        const val IDLE_ALPHA = 0.72f
        const val IDLE_MS = 5_000L
        const val FADE_MS = 400L
        const val OPEN_SCALE = 0.97f
        const val OPEN_MS = 140L
        const val SNAP_MS = 180L
        val ACCENT = Color.rgb(76, 141, 255)
        val WARNING = Color.rgb(255, 159, 10)
        val READY = Color.rgb(48, 209, 88)
    }
}
