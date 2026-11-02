package live.cohub.android.display

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.RequiresApi
import live.cohub.android.R

internal class Look(val color: Int, val pulse: Boolean, val title: String)

internal class Action(val text: String, val run: () -> Unit)

internal class Palette(val surface: Int, val text: Int, val secondary: Int, val button: Int) {
    companion object {
        fun of(context: Context): Palette {
            val night = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            return if (night) {
                Palette(Color.argb(240, 28, 28, 30), Color.WHITE, Color.argb(170, 255, 255, 255), Color.argb(40, 255, 255, 255))
            } else {
                Palette(Color.argb(245, 255, 255, 255), Color.rgb(28, 28, 30), Color.argb(150, 28, 28, 30), Color.argb(20, 0, 0, 0))
            }
        }
    }
}

internal object Tone {
    val ACCENT = Color.rgb(76, 141, 255)
    val WARNING = Color.rgb(255, 159, 10)
    val READY = Color.rgb(48, 209, 88)
}

internal fun View.dp(value: Number): Int = (value.toFloat() * resources.displayMetrics.density).toInt()

private fun View.rounded(color: Int, radius: Number) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radius).toFloat()
}

private class Dot(context: Context) : View(context) {
    private val shape = GradientDrawable().apply { shape = GradientDrawable.OVAL }
    private val pulse = ObjectAnimator.ofFloat(this, ALPHA, 1f, 0.3f).apply {
        duration = 900
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
    }
    private var pulsing = false

    init {
        background = shape
    }

    fun set(color: Int, pulsing: Boolean) {
        shape.setColor(color)
        if (pulsing == this.pulsing) return
        this.pulsing = pulsing
        if (pulsing && isAttachedToWindow) pulse.start() else if (!pulsing) rest()
    }

    private fun rest() {
        pulse.cancel()
        alpha = 1f
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (pulsing) pulse.start()
    }

    override fun onDetachedFromWindow() {
        rest()
        super.onDetachedFromWindow()
    }
}

private fun LinearLayout.header(dot: Dot, title: TextView) = LinearLayout(context).apply {
    gravity = Gravity.CENTER_VERTICAL
    addView(dot, LinearLayout.LayoutParams(dp(8), dp(8)).apply { marginEnd = dp(8) })
    addView(title, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
}.also(::addView)

private fun text(context: Context, sp: Float) = TextView(context).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    ellipsize = TextUtils.TruncateAt.END
}

internal class EdgeTab(context: Context) : FrameLayout(context) {
    private val bar = View(context).apply {
        background = rounded(Tone.READY, TAB_BAR / 2f).apply { setStroke(dp(1), Color.argb(200, 255, 255, 255)) }
        elevation = dp(2).toFloat()
    }

    init {
        addView(bar, LayoutParams(dp(TAB_BAR), dp(TAB_HEIGHT)))
        layoutParams = LayoutParams(dp(TAB_TARGET), dp(48))
        contentDescription = context.getString(R.string.overlay_sharing)
    }

    @SuppressLint("RtlHardcoded")
    fun side(left: Boolean) {
        (bar.layoutParams as LayoutParams).apply {
            gravity = Gravity.CENTER_VERTICAL or if (left) Gravity.LEFT else Gravity.RIGHT
            leftMargin = if (left) dp(TAB_INSET) else 0
            rightMargin = if (left) 0 else dp(TAB_INSET)
        }
        bar.requestLayout()
    }

    private companion object {
        const val TAB_BAR = 5
        const val TAB_HEIGHT = 28
        const val TAB_INSET = 4
        const val TAB_TARGET = 24
    }
}

internal class Pill(context: Context) : LinearLayout(context) {
    private val dot = Dot(context)
    private val title = text(context, 13f).apply {
        maxLines = 1
        maxWidth = dp(200)
    }

    init {
        elevation = dp(8).toFloat()
        setPadding(dp(12), dp(10), dp(12), dp(10))
        layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT)
        header(dot, title)
    }

    fun bind(look: Look, palette: Palette) {
        background = rounded(palette.surface, 18)
        dot.set(look.color, look.pulse)
        title.setTextColor(palette.text)
        title.text = look.title
        contentDescription = look.title
    }
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class Panel(context: Context) : LinearLayout(context), SurfaceHolder.Callback {
    private val dot = Dot(context)
    private val title = text(context, 13f).apply { maxLines = 3 }
    private val steps = text(context, 12f).apply { setLineSpacing(dp(2).toFloat(), 1f) }
    private val preview = SurfaceView(context).apply { visibility = GONE }
    private val primary = button()
    private val secondary = button()
    private var screen: Screen? = null
    private var mirror: Pair<Screen, IBinder>? = null

    init {
        orientation = VERTICAL
        elevation = dp(8).toFloat()
        setPadding(dp(12), dp(10), dp(12), dp(10))
        layoutParams = FrameLayout.LayoutParams(dp(PREVIEW_WIDTH + 24), FrameLayout.LayoutParams.WRAP_CONTENT)
        header(dot, title)
        addView(steps, block(8))
        addView(preview, LayoutParams(dp(PREVIEW_WIDTH), 0).apply { topMargin = dp(10) })
        addView(LinearLayout(context).apply {
            gravity = Gravity.END
            addView(secondary)
            addView(primary)
        }, block(8))
        preview.holder.addCallback(this)
    }

    fun bind(look: Look, palette: Palette, recent: List<String>, actions: List<Action>, shows: Screen?, maxPreview: Int) {
        background = rounded(palette.surface, 18)
        dot.set(look.color, look.pulse)
        title.setTextColor(palette.text)
        title.text = look.title
        steps.setTextColor(palette.secondary)
        steps.text = recent.joinToString("\n")
        steps.visibility = if (recent.isEmpty()) GONE else VISIBLE
        style(primary, palette, Tone.ACCENT, actions.last())
        style(secondary, palette, palette.text, actions.getOrNull(actions.size - 2))
        show(shows, maxPreview)
    }

    private fun show(target: Screen?, maxHeight: Int) {
        if (target != null) {
            val height = (dp(PREVIEW_WIDTH).toLong() * target.size.height / target.size.width).toInt().coerceAtMost(maxHeight)
            if (preview.layoutParams.height != height) preview.layoutParams = preview.layoutParams.apply { this.height = height }
        }
        preview.visibility = if (target != null) VISIBLE else GONE
        if (target === screen) return
        screen = target
        val surface = preview.holder.surface
        if (surface.isValid) preview.holder.surfaceFrame.let { mirrorInto(preview.holder, it.width(), it.height()) }
    }

    private fun mirrorInto(holder: SurfaceHolder, width: Int, height: Int) {
        unmirror()
        val target = screen ?: return
        mirror = runCatching { target to target.mirror(holder.surface, width, height) }.getOrNull()
    }

    private fun unmirror() {
        mirror?.let { (on, token) -> runCatching { on.unmirror(token) } }
        mirror = null
    }

    override fun surfaceCreated(holder: SurfaceHolder) = Unit

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = mirrorInto(holder, width, height)

    override fun surfaceDestroyed(holder: SurfaceHolder) = unmirror()

    private fun block(top: Int) = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) }

    private fun button() = text(context, 14f).apply {
        maxLines = 1
        setPadding(dp(12), dp(8), dp(12), dp(8))
        layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) }
    }

    private fun style(view: TextView, palette: Palette, color: Int, action: Action?) {
        view.visibility = if (action == null) GONE else VISIBLE
        action ?: return
        view.text = action.text
        view.setTextColor(color)
        view.background = rounded(palette.button, 12)
        view.setOnClickListener { action.run() }
    }

    private companion object {
        const val PREVIEW_WIDTH = 180
    }
}
