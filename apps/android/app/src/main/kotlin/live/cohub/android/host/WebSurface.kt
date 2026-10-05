package live.cohub.android.host

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.net.toUri
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

    fun canGoBack(): Boolean = webView.canGoBack()

    fun goBack() {
        webView.goBack()
    }

    /** A dead renderer cannot be reused; callers must build a new surface. */
    fun destroy() {
        webView.destroy()
    }

    private fun origin() = BuildConfig.WEB_ORIGIN.trimEnd('/')

    private companion object {
        val WEB_ORIGIN: Uri = BuildConfig.WEB_ORIGIN.toUri()
    }
}
