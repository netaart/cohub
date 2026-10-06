package live.cohub.android.host

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.net.toUri
import androidx.webkit.WebViewCompat
import live.cohub.android.BuildConfig

/**
 * The WebView island, reused for the process lifetime: recreating it would
 * discard the web app's state and force a cold start on every tap.
 */
@SuppressLint("SetJavaScriptEnabled")
class WebSurface(
    private val webView: WebView,
    onExternalLink: (Uri) -> Unit,
    onRenderProcessGone: () -> Unit,
) {
    init {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            // The web app owns its gestures; native pinch-zoom would fight them.
            builtInZoomControls = false
            displayZoomControls = false
            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        }
        webView.webViewClient = CohubWebViewClient(
            webOrigin = WEB_ORIGIN,
            onExternalLink = onExternalLink,
            onRenderProcessGone = onRenderProcessGone,
        )
        webView.webChromeClient = CohubWebChromeClient()
    }

    fun load(path: String = "/") {
        webView.loadUrl(origin() + path)
    }

    fun setBackgroundColor(color: Int) {
        webView.setBackgroundColor(color)
    }

    fun canGoBack(): Boolean = webView.canGoBack()

    fun goBack() {
        webView.goBack()
    }

    /** A dead renderer cannot be reused; callers must build a new surface. */
    fun destroy() {
        webView.destroy()
    }

    private fun origin() = BuildConfig.WEB_ORIGIN.trimEnd('/')

    companion object {
        private val WEB_ORIGIN: Uri = BuildConfig.WEB_ORIGIN.toUri()

        // Chromium misreports safe-area insets before M140.
        private const val SAFE_AREA_MIN_VERSION = 140

        fun reportsSafeArea(context: Context): Boolean {
            val major = WebViewCompat.getCurrentWebViewPackage(context)
                ?.versionName?.substringBefore('.')?.toIntOrNull() ?: return false
            return major >= SAFE_AREA_MIN_VERSION
        }
    }
}
