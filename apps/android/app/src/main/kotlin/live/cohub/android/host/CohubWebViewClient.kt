package live.cohub.android.host

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import live.cohub.android.R

/**
 * Only the Cohub origin loads in-shell; anything else goes to the system
 * browser, so the bridge injection surface never sees third-party pages.
 *
 * Lint only recognises the `onRenderProcessGone` override on anonymous
 * `WebViewClient` objects, hence the suppression.
 */
@SuppressLint("MissingOnRenderProcessGone")
class CohubWebViewClient(private val listener: SurfaceListener) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (WebOrigin.contains(url)) return false
        listener.onExternalLink(url)
        return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        listener.onPageStarted()
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
        listener.onNavigated(url)
    }

    /**
     * The renderer can be killed under memory pressure; the default behaviour is
     * to crash the app. Rebuilding the view keeps that invisible to the user.
     */
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail?): Boolean {
        Toast.makeText(view.context, R.string.web_view_recovering, Toast.LENGTH_SHORT).show()
        listener.onRenderProcessGone()
        return true
    }
}
