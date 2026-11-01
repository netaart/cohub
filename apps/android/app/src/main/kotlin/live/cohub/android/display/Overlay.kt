package live.cohub.android.display

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import live.cohub.android.R

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
@SuppressLint("ClickableViewAccessibility")
internal class Overlay(private val service: ControlService, private val display: DeviceDisplay, scope: CoroutineScope) {
    private val windows = service.getSystemService(WindowManager::class.java)
    private val density = service.resources.displayMetrics.density
    private val root = FrameLayout(service)
    private val card = LinearLayout(service).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(SURFACE, 18f)
        elevation = dp(8)
        setPadding(dp(12).toInt(), dp(10).toInt(), dp(12).toInt(), dp(12).toInt())
    }
    private val dot = View(service).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL } }
    private val label = TextView(service).apply {
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
    }
    private val preview = SurfaceView(service)
    private val actions = LinearLayout(service).apply { gravity = Gravity.END }
    private val primary = button(ACCENT)
    private val secondary = button(Color.WHITE)
    private val pulse = ObjectAnimator.ofFloat(dot, View.ALPHA, 1f, 0.3f).apply {
        duration = 900
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
    }
    private var shown: Served? = null
    private var open = false
    private var attached = false
    private var mirror: IBinder? = null
    private val job: Job

    init {
        val header = LinearLayout(service).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(dot, LinearLayout.LayoutParams(dp(8).toInt(), dp(8).toInt()).apply { marginEnd = dp(8).toInt() })
            addView(label, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        card.addView(header)
        card.addView(preview, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0).apply { topMargin = dp(10).toInt() })
        actions.addView(secondary)
        actions.addView(primary)
        card.addView(actions, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8).toInt() })
        root.addView(card, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        card.setOnClickListener { setOpen(!open) }
        root.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_OUTSIDE) setOpen(false)
            false
        }
        preview.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) = Unit
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                unmirror()
                mirror = shown?.screen?.mirror(holder.surface, width, height)
            }
            override fun surfaceDestroyed(holder: SurfaceHolder) = unmirror()
        })
        job = scope.launch(Dispatchers.Main) {
            combine(display.changes, display.status) { _, _ -> }.collect { render(display.served()) }
        }
    }

    private fun render(all: List<Served>) {
        val next = all.firstOrNull { it.held } ?: all.firstOrNull { it.activity != null } ?: all.firstOrNull { !it.screen.agent }
        if (next == null) return detach()
        if (next !== shown) {
            shown = next
            setOpen(false)
        }
        val (color, text) = when {
            next.held -> WARNING to service.getString(R.string.overlay_held)
            next.activity != null -> ACCENT to (next.activity?.label?.let { service.getString(R.string.overlay_activity, it) } ?: service.getString(R.string.overlay_working))
            else -> READY to service.getString(R.string.overlay_sharing)
        }
        (dot.background as GradientDrawable).setColor(color)
        label.text = text
        if (next.activity != null && !next.held) pulse.start() else pulse.end()
        primary.text = service.getString(when {
            next.held -> R.string.overlay_hand_back
            next.activity != null -> R.string.overlay_stop
            else -> R.string.overlay_stop_sharing
        })
        primary.setOnClickListener {
            when {
                next.held -> display.handBack(next)
                next.activity != null -> display.interrupt(next)
                else -> display.stop()
            }
        }
        secondary.visibility = if (!next.held && next.activity != null) View.VISIBLE else View.GONE
        secondary.text = service.getString(R.string.overlay_take_over)
        secondary.setOnClickListener {
            display.takeOver(next)
            setOpen(false)
        }
        attach()
    }

    private fun setOpen(value: Boolean) {
        open = value
        val served = shown
        val agent = served?.screen?.agent == true
        preview.layoutParams = (preview.layoutParams as LinearLayout.LayoutParams).apply {
            height = if (open && served != null && agent) (dp(PREVIEW_WIDTH) * served.screen.size.height / served.screen.size.width).toInt() else 0
        }
        if (!open || !agent) unmirror()
        actions.visibility = if (open) View.VISIBLE else View.GONE
        label.maxWidth = dp(if (open) PREVIEW_WIDTH else PILL_WIDTH).toInt()
        card.layoutParams = (card.layoutParams as FrameLayout.LayoutParams).apply {
            width = if (open) dp(PREVIEW_WIDTH + 24).toInt() else FrameLayout.LayoutParams.WRAP_CONTENT
        }
        if (attached) windows.updateViewLayout(root, params())
    }

    private fun attach() {
        if (attached) return
        runCatching { windows.addView(root, params()) }.onSuccess { attached = true }
    }

    private fun detach() {
        unmirror()
        shown = null
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
        gravity = Gravity.TOP or Gravity.END
        x = dp(12).toInt()
        y = windows.currentWindowMetrics.windowInsets.getInsets(WindowInsets.Type.statusBars()).top + dp(8).toInt()
    }

    fun close() {
        job.cancel()
        detach()
    }

    private fun button(color: Int) = TextView(service).apply {
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setPadding(dp(12).toInt(), dp(8).toInt(), dp(12).toInt(), dp(8).toInt())
        background = rounded(BUTTON, 12f)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8).toInt() }
    }

    private fun rounded(color: Int, radius: Float) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius)
    }

    private fun dp(value: Number) = value.toFloat() * density

    private companion object {
        const val PILL_WIDTH = 200
        const val PREVIEW_WIDTH = 240
        val SURFACE = Color.argb(235, 28, 28, 30)
        val BUTTON = Color.argb(40, 255, 255, 255)
        val ACCENT = Color.rgb(76, 141, 255)
        val WARNING = Color.rgb(255, 159, 10)
        val READY = Color.rgb(48, 209, 88)
    }
}
