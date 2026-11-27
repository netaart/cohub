package live.cohub.android.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
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

    val failure: LaunchFailure? get() = (state as? State.Failed)?.failure

    private val brand = context.getColor(R.color.ic_launcher_background)
    private val net = LaunchNet(context).apply { contentDescription = context.getString(R.string.launch_loading) }
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

    init {
        isClickable = true
        addView(net, LayoutParams(MATCH_PARENT, MATCH_PARENT))
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
        net.anchor(at[0] + icon.width / 2f - own[0], at[1] + icon.height / 2f - own[1], size.toFloat())
        requestLayout()
    }

    fun show(next: State) {
        if (net.lifting) {
            status.animate().cancel()
            status.alpha = 1f
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_AUTO
            net.hold()
        }
        val appearing = !isVisible
        isVisible = true
        behind.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        if (appearing) net.restart()
        if (!appearing && next == state) return
        state = next
        render()
    }

    fun dismiss() {
        if (!isVisible || net.lifting) return
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        behind.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        val now = SystemClock.uptimeMillis()
        MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, 0f, 0f, 0).run {
            super.dispatchTouchEvent(this)
            recycle()
        }
        status.animate().alpha(0f).setDuration(FADE_MS).start()
        net.lift { isVisible = false }
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (!net.lifting) return super.dispatchTouchEvent(event)
        return event.actionMasked != MotionEvent.ACTION_DOWN || !net.reveals(event.x, event.y)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        val inset = ViewCompat.getRootWindowInsets(this)?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom ?: 0
        val below = (net.originY + net.clearance).toInt() + 32.dp
        status.offsetTopAndBottom(min(below, height - inset - 16.dp - status.height) - status.top)
        net.clear(if (status.isVisible) RectF(status.left.toFloat(), status.top.toFloat(), status.right.toFloat(), status.bottom.toFloat()) else null)
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
        net.phase = when (val current = state) {
            State.Loading -> LaunchNet.Phase.LOADING
            State.Slow -> LaunchNet.Phase.SLOW
            is State.Failed -> when (current.failure) {
                LaunchFailure.OFFLINE -> LaunchNet.Phase.OFFLINE
                LaunchFailure.BROKEN -> LaunchNet.Phase.BROKEN
            }
        }
        net.importantForAccessibility = if (failure != null) IMPORTANT_FOR_ACCESSIBILITY_NO else IMPORTANT_FOR_ACCESSIBILITY_YES
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

    private companion object {
        const val FADE_MS = 150L
        const val STATUS_FADE_MS = 200L
    }
}
