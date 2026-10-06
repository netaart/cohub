package live.cohub.android.host

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import live.cohub.android.BuildConfig

/**
 * The WebView island, reused for the activity's lifetime: recreating it would
 * discard the web app's state and force a cold start on every tap.
 */
@SuppressLint("SetJavaScriptEnabled")
class WebSurface(
    context: Context,
    onExternalLink: (Uri) -> Unit,
    onNavigated: (url: String) -> Unit,
    onRenderProcessGone: () -> Unit,
) {
    val view = WebView(context)

    init {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            // The web app owns its gestures; native pinch-zoom would fight them.
            builtInZoomControls = false
            displayZoomControls = false
        }
        if (BuildConfig.WEB_DEBUGGING) WebView.setWebContentsDebuggingEnabled(true)
        view.webViewClient = CohubWebViewClient(onExternalLink, onNavigated, onRenderProcessGone)
        view.webChromeClient = CohubWebChromeClient()
    }

    fun load(path: String = "/") {
        view.loadUrl(WebOrigin.urlOf(path))
    }

    fun setBackgroundColor(color: Int) {
        view.setBackgroundColor(color)
    }

    fun canGoBack(): Boolean = view.canGoBack()

    fun goBack() {
        view.goBack()
    }

    /** A dead renderer cannot be reused; callers must build a new surface. */
    fun destroy() {
        view.destroy()
    }

    companion object {
        // Chromium misreports safe-area insets before M140.
        private const val SAFE_AREA_MIN_VERSION = 140

        fun reportsSafeArea(context: Context): Boolean {
            val major = WebViewCompat.getCurrentWebViewPackage(context)
                ?.versionName?.substringBefore('.')?.toIntOrNull() ?: return false
            return major >= SAFE_AREA_MIN_VERSION
        }
    }
}
