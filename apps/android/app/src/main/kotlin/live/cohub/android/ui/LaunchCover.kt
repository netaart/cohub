package live.cohub.android.ui

import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.ShapeDrawable
import android.graphics.drawable.shapes.OvalShape
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.StringRes
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.doOnLayout
import androidx.core.view.isVisible
import live.cohub.android.R
import live.cohub.android.host.LaunchFailure
import kotlin.math.min

class LaunchCover(context: Context, private val behind: View, private val onAction: () -> Unit) : FrameLayout(context) {

    sealed interface State {
        data object Loading : State
        data object Slow : State
        data class Failed(val failure: LaunchFailure) : State
    }

    private var state: State = State.Loading
    private var lifting = false
    private var onScreen = false

    val failure: LaunchFailure? get() = (state as? State.Failed)?.failure

    private val brand = context.getColor(R.color.ic_launcher_background)
    private val mark = Mark(context).apply { contentDescription = context.getString(R.string.launch_loading) }
    private val title = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        setTypeface(typeface, Typeface.BOLD)
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private val detail = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        setTextColor(themeColor(android.R.attr.textColorSecondary))
    }
    private val button = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        setTypeface(typeface, Typeface.BOLD)
        gravity = Gravity.CENTER
        minHeight = 48.dp
        setPadding(24.dp, 0, 24.dp, 0)
        isClickable = true
        isFocusable = true
        setOnClickListener { onAction() }
    }
    private val status = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        isVisible = false
        for (text in listOf(title, detail)) {
            text.gravity = Gravity.CENTER
            text.maxWidth = 320.dp
        }
        addView(title)
        addView(detail, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = 6.dp })
        addView(button, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = 12.dp })
    }

    private val spin = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = TURN_MS
        startDelay = HOLD_MS
        repeatCount = ValueAnimator.INFINITE
        interpolator = Tick
        addUpdateListener { mark.turn = it.animatedValue as Float }
    }

    init {
        setBackgroundColor(context.getColor(R.color.shell_background))
        isClickable = true
        addView(mark, LayoutParams(160.dp, 160.dp, Gravity.CENTER))
        addView(status, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER_HORIZONTAL).apply {
            leftMargin = 24.dp
            rightMargin = 24.dp
        })
        render()
    }

    fun alignTo(icon: View) = doOnLayout {
        // The platform's icon view is the tile; the compat one is the glyph's whole canvas.
        val size = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) icon.width else icon.width * 2 / 3
        if (size <= 0) return@doOnLayout
        val at = IntArray(2).also(icon::getLocationInWindow)
        val own = IntArray(2).also(::getLocationInWindow)
        mark.layoutParams = mark.layoutParams.apply {
            width = size
            height = size
        }
        mark.translationX = at[0] + icon.width / 2f - own[0] - width / 2f
        mark.translationY = at[1] + icon.height / 2f - own[1] - height / 2f
        requestLayout()
    }

    fun show(next: State) {
        animate().cancel()
        alpha = 1f
        lifting = false
        val appearing = !isVisible
        isVisible = true
        behind.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        if (!appearing && next == state) return
        state = next
        render()
    }

    fun dismiss() {
        if (!isVisible || lifting) return
        lifting = true
        animate().alpha(0f).setDuration(FADE_MS).withEndAction {
            isVisible = false
            behind.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        }.start()
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        val inset = ViewCompat.getRootWindowInsets(this)?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom ?: 0
        val below = (mark.bottom + mark.translationY).toInt() + 32.dp
        status.offsetTopAndBottom(min(below, height - inset - 16.dp - status.height) - status.top)
    }

    private fun render() {
        when (val current = state) {
            State.Loading -> explain(null)
            State.Slow -> explain(R.string.launch_slow, action = R.string.launch_reload)
            is State.Failed -> when (current.failure) {
                LaunchFailure.OFFLINE ->
                    explain(R.string.launch_offline, R.string.launch_offline_detail, R.string.launch_retry, prominent = true)
                LaunchFailure.BROKEN -> explain(R.string.launch_failed, action = R.string.launch_retry, prominent = true)
            }
        }
        val failed = failure != null
        mark.importantForAccessibility = if (failed) IMPORTANT_FOR_ACCESSIBILITY_NO else IMPORTANT_FOR_ACCESSIBILITY_YES
        updateSpin()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        onScreen = isVisible
        updateSpin()
    }

    private fun updateSpin() {
        if (onScreen && failure == null) {
            if (!spin.isStarted) spin.start()
        } else {
            spin.cancel()
            mark.turn = 0f
        }
    }

    private fun explain(
        @StringRes heading: Int?,
        @StringRes note: Int? = null,
        @StringRes action: Int? = null,
        prominent: Boolean = false,
    ) {
        val appearing = !status.isVisible && heading != null
        title.text = heading?.let(context::getString)
        detail.text = note?.let(context::getString)
        detail.isVisible = note != null
        button.text = action?.let(context::getString)
        button.setTextColor(if (prominent) Color.WHITE else brand)
        val pill = GradientDrawable().apply {
            cornerRadius = 24.dp.toFloat()
            setColor(if (prominent) brand else Color.TRANSPARENT)
        }
        val mask = GradientDrawable().apply {
            cornerRadius = 24.dp.toFloat()
            setColor(Color.WHITE)
        }
        button.background = RippleDrawable(ColorStateList.valueOf(Color.argb(48, 128, 128, 128)), pill, mask)
        status.isVisible = heading != null
        if (!appearing) return
        status.alpha = 0f
        status.animate().alpha(1f).setDuration(STATUS_FADE_MS).start()
    }

    private fun themeColor(attr: Int): Int {
        val styled = context.obtainStyledAttributes(intArrayOf(attr))
        return try {
            styled.getColor(0, Color.GRAY)
        } finally {
            styled.recycle()
        }
    }

    private val Int.dp: Int get() = (this * resources.displayMetrics.density).toInt()

    private class Mark(context: Context) : View(context) {
        var turn = 0f
            set(value) {
                field = value
                invalidate()
            }

        private val glyph = requireNotNull(context.getDrawable(R.drawable.ic_launcher_foreground))

        // From Android 12 the splash masks its tile like a launcher icon; before, with a circle.
        private val tile: Drawable = context.getColor(R.color.ic_launcher_background).let { brand ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AdaptiveIconDrawable(ColorDrawable(brand), null)
            } else {
                ShapeDrawable(OvalShape()).apply { paint.color = brand }
            }
        }

        override fun onDraw(canvas: Canvas) {
            tile.setBounds(0, 0, width, height)
            tile.draw(canvas)
            // As in an adaptive icon, the glyph's canvas is 1.5× the tile.
            glyph.setBounds(-width / 4, -height / 4, width + width / 4, height + height / 4)
            canvas.rotate(turn, width / 2f, height / 2f)
            glyph.draw(canvas)
        }
    }

    private object Tick : TimeInterpolator {
        private const val TURN = 2f / 3
        private val ease = PathInterpolator(0.16f, 1f, 0.3f, 1f)

        override fun getInterpolation(input: Float): Float = if (input < TURN) ease.getInterpolation(input / TURN) else 1f
    }

    private companion object {
        const val TURN_MS = 900L
        const val HOLD_MS = 300L
        const val FADE_MS = 180L
        const val STATUS_FADE_MS = 200L
    }
}
