package live.cohub.android.ui

import android.content.Context
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import live.cohub.android.host.WebSurface

class SurfaceContainer(context: Context) : FrameLayout(context) {

    init {
        if (!WebSurface.reportsSafeArea(context)) {
            ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
                val safe = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or
                        WindowInsetsCompat.Type.displayCutout() or
                        WindowInsetsCompat.Type.ime(),
                )
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                WindowInsetsCompat.CONSUMED
            }
        }
    }

    fun show(surface: View) {
        removeAllViews()
        addView(surface, LayoutParams(MATCH_PARENT, MATCH_PARENT))
    }
}
