package live.cohub.android.host

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asExecutor
import live.cohub.android.BuildConfig

interface SurfaceListener {
    fun onExternalLink(url: Uri)
    fun onPageStarted()
    fun onNavigated(url: String)
    fun onRenderProcessGone(crashed: Boolean)
    fun onShowFileChooser(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean
    fun onDownload(url: String, contentDisposition: String?, mimeType: String?)
}

/**
 * The WebView island, reused for the activity's lifetime: recreating it would
 * discard the web app's state and force a cold start on every tap.
 */
@SuppressLint("SetJavaScriptEnabled")
class WebSurface(context: Context, listener: SurfaceListener) {
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
        // Waived priority gets the renderer reclaimed whenever the app is hidden.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        view.webViewClient = CohubWebViewClient(listener)
        view.webChromeClient = CohubWebChromeClient(listener)
        view.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            listener.onDownload(url, contentDisposition, mimeType)
        }
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

    fun pause() {
        view.onPause()
    }

    fun resume() {
        view.onResume()
    }

    /** A dead renderer cannot be reused; callers must build a new surface. */
    fun destroy() {
        view.destroy()
    }

    companion object {
        private const val TAG = "CohubShell"

        // Chromium misreports safe-area insets before M140.
        private const val SAFE_AREA_MIN_VERSION = 140

        fun reportsSafeArea(context: Context): Boolean {
            val major = WebViewCompat.getCurrentWebViewPackage(context)
                ?.versionName?.substringBefore('.')?.toIntOrNull() ?: return false
            return major >= SAFE_AREA_MIN_VERSION
        }

        @OptIn(markerClass = [WebViewCompat.ExperimentalAsyncStartUp::class])
        fun startUp(context: Context, onReady: () -> Unit) {
            val main = ContextCompat.getMainExecutor(context)
            val config = WebViewStartUpConfig.Builder(Dispatchers.IO.asExecutor()).build()
            WebViewCompat.startUpWebView(
                context,
                config,
                object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
                    override fun onResult(result: WebViewStartUpResult) = main.execute(onReady)

                    override fun onError(error: WebViewStartupException) = main.execute {
                        Log.w(TAG, "Async WebView start-up failed", error)
                        onReady()
                    }
                },
            )
        }
    }
}
